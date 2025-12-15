const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { ethers } = require('ethers');
const contractService = require('../services/contractService');
const { getNetworkFromRequest } = require('../utils/networkHelper');
const { checkMaintenanceMode } = require('../middleware/maintenanceMode');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Apply maintenance mode middleware to all vendor routes
router.use(checkMaintenanceMode('vendor'));

/**
 * GET /api/vendors
 * Get all vendors with their plans and subscription stats
 */
router.get('/', async (req, res, next) => {
  try {
    // Get all unique vendors
    const vendorsResult = await pool.query(
      `SELECT DISTINCT vendor_address 
       FROM subscription_plans 
       ORDER BY vendor_address`
    );
    
    const vendors = [];
    
    for (const vendorRow of vendorsResult.rows) {
      const vendorAddress = vendorRow.vendor_address.toLowerCase();
      
      // Get all plans for this vendor
      const plansResult = await pool.query(
        `SELECT * FROM subscription_plans 
         WHERE vendor_address = $1 
         ORDER BY created_at DESC`,
        [vendorAddress]
      );
      
      // Get all subscriptions for this vendor's plans
      const planIds = plansResult.rows.map(p => p.plan_id);
      let subscriptionsResult = { rows: [] };
      
      if (planIds.length > 0) {
        subscriptionsResult = await pool.query(
          `SELECT s.*, sp.name as plan_name, sp.price as plan_price
           FROM subscriptions s
           JOIN subscription_plans sp ON s.plan_id = sp.plan_id
           WHERE s.plan_id = ANY($1::text[])
           ORDER BY s.created_at DESC`,
          [planIds]
        );
      }
      
      // Get blockchain data for subscriptions
      const contract = await contractService.getContract();
      let activeSubscriptions = 0;
      let expiredSubscriptions = 0;
      let totalRevenue = '0';
      
      for (const sub of subscriptionsResult.rows) {
        try {
          const isValid = await contract.isSubscriptionValid(sub.token_id);
          if (isValid) {
            activeSubscriptions++;
          } else {
            expiredSubscriptions++;
          }
          
          // Add to revenue
          const price = parseFloat(sub.plan_price || '0');
          totalRevenue = (parseFloat(totalRevenue) + price).toString();
        } catch (error) {
          console.error(`Error checking subscription ${sub.token_id}:`, error);
        }
      }
      
      // Get first and last plan creation dates
      const firstPlanDate = plansResult.rows.length > 0 
        ? plansResult.rows[plansResult.rows.length - 1].created_at 
        : null;
      const lastPlanDate = plansResult.rows.length > 0 
        ? plansResult.rows[0].created_at 
        : null;
      
      vendors.push({
        vendorAddress: vendorAddress,
        totalPlans: plansResult.rows.length,
        activePlans: plansResult.rows.filter(p => p.active).length,
        totalSubscriptions: subscriptionsResult.rows.length,
        activeSubscriptions: activeSubscriptions,
        expiredSubscriptions: expiredSubscriptions,
        totalRevenue: totalRevenue,
        firstPlanDate: firstPlanDate,
        lastPlanDate: lastPlanDate,
        plans: plansResult.rows
      });
    }
    
    res.json(vendors);
  } catch (error) {
    console.error('Error fetching vendors:', error);
    next(error);
  }
});

/**
 * GET /api/vendors/:vendorAddress
 * Get detailed information about a specific vendor (filtered by network if provided)
 */
router.get('/:vendorAddress', async (req, res, next) => {
  try {
    const { vendorAddress } = req.params;
    const address = vendorAddress.toLowerCase();
    
    // Get network from request (vendor's selected network)
    const network = await getNetworkFromRequest(req);
    console.log(`[Vendor Stats] Fetching stats for vendor ${address} on network: ${network}`);
    
    // Get all plans for this vendor, filtered by network
    let plansQuery = `SELECT * FROM subscription_plans WHERE vendor_address = $1`;
    const plansParams = [address];
    
    if (network) {
      plansQuery += ` AND (network = $2 OR network IS NULL)`;
      plansParams.push(network);
    }
    
    plansQuery += ` ORDER BY created_at DESC`;
    
    const plansResult = await pool.query(plansQuery, plansParams);
    
    console.log(`[Vendor Stats] Found ${plansResult.rows.length} plans for network ${network}`);
    
    if (plansResult.rows.length === 0) {
      // Return empty stats instead of 404 if no plans found for this network
      return res.json({
        vendorAddress: address,
        totalPlans: 0,
        activePlans: 0,
        totalSubscriptions: 0,
        activeSubscriptions: 0,
        expiredSubscriptions: 0,
        totalCustomers: 0,
        totalRevenue: '0',
        firstPlanDate: null,
        lastPlanDate: null,
        plans: [],
        subscriptions: []
      });
    }
    
    // Get all subscriptions for this vendor's plans (already filtered by network via plans)
    const planIds = plansResult.rows.map(p => p.plan_id);
    const subscriptionsResult = await pool.query(
      `SELECT s.*, sp.name as plan_name, sp.description as plan_description, 
              sp.price as plan_price, sp.duration as plan_duration, sp.network as plan_network
       FROM subscriptions s
       JOIN subscription_plans sp ON s.plan_id = sp.plan_id
       WHERE s.plan_id = ANY($1::text[])
       ORDER BY s.created_at DESC`,
      [planIds]
    );
    
    console.log(`[Vendor Stats] Found ${subscriptionsResult.rows.length} subscriptions for network ${network}`);
    
    // Get blockchain data using network-specific contract
    let contract = null;
    try {
      contract = await contractService.getContract(network);
    } catch (contractError) {
      console.error(`[Vendor Stats] Error getting contract for network ${network}:`, contractError);
      // Continue without blockchain data
    }
    
    const subscriptions = [];
    let activeSubscriptions = 0;
    let expiredSubscriptions = 0;
    let totalRevenue = '0';
    
    for (const sub of subscriptionsResult.rows) {
      try {
        if (!contract) {
          // No contract available - use database data only
          const price = parseFloat(sub.plan_price || '0');
          totalRevenue = (parseFloat(totalRevenue) + price).toString();
          
          subscriptions.push({
            ...sub,
            blockchain: null,
            status: 'unknown',
            daysRemaining: 0
          });
          continue;
        }
        
        const subscription = await contract.getSubscription(sub.token_id);
        const isValid = await contract.isSubscriptionValid(sub.token_id);
        const plan = await contract.getPlan(subscription.planId);
        
        if (isValid) {
          activeSubscriptions++;
        } else {
          expiredSubscriptions++;
        }
        
        const price = parseFloat(sub.plan_price || '0');
        totalRevenue = (parseFloat(totalRevenue) + price).toString();
        
        subscriptions.push({
          ...sub,
          blockchain: {
            tokenId: subscription.tokenId.toString(),
            planId: subscription.planId.toString(),
            subscriber: subscription.subscriber,
            startTime: subscription.startTime.toString(),
            endTime: subscription.endTime.toString(),
            active: subscription.active,
            isValid: isValid,
            published: subscription.published !== undefined ? subscription.published : true,
            paused: subscription.paused || false,
            plan: {
              name: plan.name,
              price: plan.price.toString(),
              duration: plan.duration.toString()
            }
          },
          status: isValid ? 'active' : 'expired',
          daysRemaining: isValid ? Math.max(0, Math.floor((parseInt(subscription.endTime) - Date.now() / 1000) / 86400)) : 0
        });
      } catch (error) {
        console.error(`[Vendor Stats] Error fetching blockchain data for subscription ${sub.token_id}:`, error);
        // Use database data as fallback
        const price = parseFloat(sub.plan_price || '0');
        totalRevenue = (parseFloat(totalRevenue) + price).toString();
        
        subscriptions.push({
          ...sub,
          blockchain: null,
          status: 'unknown',
          daysRemaining: 0
        });
      }
    }
    
    // Get unique customers (only from subscriptions on this network)
    const uniqueCustomers = new Set(subscriptionsResult.rows.map(s => s.subscriber_address));
    
    const vendorDetails = {
      vendorAddress: address,
      network: network, // Include network in response for debugging
      totalPlans: plansResult.rows.length,
      activePlans: plansResult.rows.filter(p => p.active).length,
      totalSubscriptions: subscriptions.length,
      activeSubscriptions: activeSubscriptions,
      expiredSubscriptions: expiredSubscriptions,
      totalCustomers: uniqueCustomers.size,
      totalRevenue: totalRevenue,
      firstPlanDate: plansResult.rows[plansResult.rows.length - 1]?.created_at,
      lastPlanDate: plansResult.rows[0]?.created_at,
      plans: plansResult.rows,
      subscriptions: subscriptions
    };
    
    console.log(`[Vendor Stats] Response for ${address} on ${network}:`, {
      totalPlans: vendorDetails.totalPlans,
      totalCustomers: vendorDetails.totalCustomers,
      totalRevenue: vendorDetails.totalRevenue
    });
    
    res.json(vendorDetails);
  } catch (error) {
    console.error('[Vendor Stats] Error fetching vendor details:', error);
    // Return empty stats instead of crashing
    res.json({
      vendorAddress: req.params.vendorAddress.toLowerCase(),
      network: req.query.network || 'localhost',
      totalPlans: 0,
      activePlans: 0,
      totalSubscriptions: 0,
      activeSubscriptions: 0,
      expiredSubscriptions: 0,
      totalCustomers: 0,
      totalRevenue: '0',
      firstPlanDate: null,
      lastPlanDate: null,
      plans: [],
      subscriptions: []
    });
  }
});

/**
 * GET /api/vendors/:vendorAddress/plans
 * Get all plans for a specific vendor
 */
router.get('/:vendorAddress/plans', async (req, res, next) => {
  try {
    const { vendorAddress } = req.params;
    
    const plansResult = await pool.query(
      `SELECT * FROM subscription_plans 
       WHERE vendor_address = $1 
       ORDER BY created_at DESC`,
      [vendorAddress.toLowerCase()]
    );
    
    res.json(plansResult.rows);
  } catch (error) {
    console.error('Error fetching vendor plans:', error);
    next(error);
  }
});

/**
 * GET /api/vendors/:vendorAddress/subscriptions
 * Get all subscriptions for a vendor's plans
 */
router.get('/:vendorAddress/subscriptions', async (req, res, next) => {
  try {
    const { vendorAddress } = req.params;
    
    // Get all plans for this vendor
    const plansResult = await pool.query(
      `SELECT plan_id FROM subscription_plans 
       WHERE vendor_address = $1`,
      [vendorAddress.toLowerCase()]
    );
    
    const planIds = plansResult.rows.map(p => p.plan_id);
    
    if (planIds.length === 0) {
      return res.json([]);
    }
    
    const subscriptionsResult = await pool.query(
      `SELECT s.*, sp.name as plan_name, sp.price as plan_price
       FROM subscriptions s
       JOIN subscription_plans sp ON s.plan_id = sp.plan_id
       WHERE s.plan_id = ANY($1::text[])
       ORDER BY s.created_at DESC`,
      [planIds]
    );
    
    res.json(subscriptionsResult.rows);
  } catch (error) {
    console.error('Error fetching vendor subscriptions:', error);
    next(error);
  }
});

/**
 * PUT /api/vendors/:vendorAddress/network
 * Update vendor's preferred network
 */
router.put('/:vendorAddress/network', async (req, res, next) => {
  try {
    const { vendorAddress } = req.params;
    const { network } = req.body;
    
    if (!network) {
      return res.status(400).json({ error: 'Network is required' });
    }
    
    // Check if vendor profile exists
    const profileCheck = await pool.query(
      'SELECT * FROM vendor_profiles WHERE vendor_address = $1',
      [vendorAddress.toLowerCase()]
    );
    
    if (profileCheck.rows.length === 0) {
      // Create vendor profile if it doesn't exist
      await pool.query(
        `INSERT INTO vendor_profiles (vendor_address, network, created_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (vendor_address) DO UPDATE SET network = EXCLUDED.network, updated_at = NOW()`,
        [vendorAddress.toLowerCase(), network]
      );
    } else {
      // Update existing profile
      await pool.query(
        `UPDATE vendor_profiles 
         SET network = $1, updated_at = NOW()
         WHERE vendor_address = $2`,
        [network, vendorAddress.toLowerCase()]
      );
    }
    
    res.json({ 
      success: true, 
      vendorAddress: vendorAddress.toLowerCase(),
      network: network
    });
  } catch (error) {
    console.error('Error updating vendor network:', error);
    next(error);
  }
});

module.exports = router;

