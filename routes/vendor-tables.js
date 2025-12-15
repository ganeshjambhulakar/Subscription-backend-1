const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { ethers } = require('ethers');
const contractService = require('../services/contractService');
const { getNetworkFromRequest } = require('../utils/networkHelper');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * GET /api/vendor/apps
 * Get vendor's apps with pagination, search, and sorting (includes both subscription and checkout apps)
 */
router.get('/apps', async (req, res, next) => {
  try {
    const { vendorAddress } = req.query;
    if (!vendorAddress) {
      return res.status(400).json({ error: 'vendorAddress is required' });
    }

    const { page = 1, limit = 25, search = '', sortBy = 'created_at', sortOrder = 'desc' } = req.query;
    const offset = (page - 1) * limit;

    const { network } = req.query; // Get network filter
    
    // Query subscription apps
    let subscriptionQuery = `
      SELECT 
        app_id,
        vendor_address,
        name,
        description,
        api_key,
        active,
        network,
        created_at,
        updated_at,
        'subscription' as app_type
      FROM apps
      WHERE vendor_address = $1
    `;
    const subscriptionParams = [vendorAddress.toLowerCase()];
    let subscriptionParamCount = 1;
    
    // Filter by network if provided
    if (network) {
      subscriptionParamCount++;
      subscriptionQuery += ` AND (network = $${subscriptionParamCount} OR network IS NULL)`;
      subscriptionParams.push(network);
    }

    if (search) {
      subscriptionParamCount++;
      subscriptionQuery += ` AND (name ILIKE $${subscriptionParamCount} OR description ILIKE $${subscriptionParamCount} OR app_id::text ILIKE $${subscriptionParamCount})`;
      subscriptionParams.push(`%${search}%`);
    }

    // Query checkout apps
    let checkoutQuery = `
      SELECT 
        app_id,
        vendor_address,
        app_name as name,
        description,
        api_key,
        status as active,
        'localhost' as network,
        created_at,
        updated_at,
        'checkout' as app_type
      FROM checkout_apps
      WHERE vendor_address = $1 AND status = 'active'
    `;
    const checkoutParams = [vendorAddress.toLowerCase()];
    let checkoutParamCount = 1;
    
    // Filter checkout apps by network if provided
    if (network) {
      checkoutParamCount++;
      checkoutQuery += ` AND ($${checkoutParamCount} = 'localhost' OR $${checkoutParamCount} IS NULL)`;
      checkoutParams.push(network);
    }

    if (search) {
      checkoutParamCount++;
      checkoutQuery += ` AND (app_name ILIKE $${checkoutParamCount} OR description ILIKE $${checkoutParamCount} OR app_id ILIKE $${checkoutParamCount})`;
      checkoutParams.push(`%${search}%`);
    }

    // Execute both queries
    const [subscriptionResult, checkoutResult] = await Promise.all([
      pool.query(subscriptionQuery, subscriptionParams),
      pool.query(checkoutQuery, checkoutParams)
    ]);

    // Combine results
    let allApps = [
      ...subscriptionResult.rows,
      ...checkoutResult.rows
    ];

    // Apply sorting
    const validSortColumns = ['app_id', 'name', 'active', 'created_at'];
    const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'created_at';
    const sortDirection = sortOrder.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    allApps.sort((a, b) => {
      let aVal, bVal;
      if (sortColumn === 'created_at') {
        aVal = new Date(a.created_at);
        bVal = new Date(b.created_at);
      } else if (sortColumn === 'name') {
        aVal = (a.name || '').toLowerCase();
        bVal = (b.name || '').toLowerCase();
      } else if (sortColumn === 'active') {
        aVal = a.active === true || a.active === 'active' ? 1 : 0;
        bVal = b.active === true || b.active === 'active' ? 1 : 0;
      } else {
        aVal = a[sortColumn] || '';
        bVal = b[sortColumn] || '';
      }
      
      if (sortDirection === 'ASC') {
        return aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
      } else {
        return aVal < bVal ? 1 : aVal > bVal ? -1 : 0;
      }
    });

    // Apply pagination
    const total = allApps.length;
    const paginatedApps = allApps.slice(offset, offset + parseInt(limit));

    res.json({
      data: paginatedApps,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/vendor/plans
 * Get vendor's plans with pagination, search, and sorting
 */
router.get('/plans', async (req, res, next) => {
  try {
    const { vendorAddress, network } = req.query;
    if (!vendorAddress) {
      return res.status(400).json({ error: 'vendorAddress is required' });
    }

    const { page = 1, limit = 25, search = '', sortBy = 'created_at', sortOrder = 'desc', appId } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT 
        sp.id,
        sp.plan_id,
        sp.vendor_address,
        sp.name,
        sp.description,
        sp.price,
        sp.duration,
        sp.active,
        sp.max_subscriptions,
        sp.pause_enabled,
        sp.max_pause_attempts,
        sp.app_id,
        sp.created_at,
        a.name as app_name
      FROM subscription_plans sp
      LEFT JOIN apps a ON sp.app_id = a.app_id AND a.vendor_address = sp.vendor_address
      WHERE sp.vendor_address = $1
    `;
    const params = [vendorAddress.toLowerCase()];
    let paramCount = 1;
    
    // Filter by network if provided
    if (network) {
      paramCount++;
      query += ` AND (sp.network = $${paramCount} OR sp.network IS NULL)`;
      params.push(network);
    }

    if (appId) {
      paramCount++;
      query += ` AND app_id = $${paramCount}`;
      params.push(appId);
    }

    if (search) {
      paramCount++;
      query += ` AND (name ILIKE $${paramCount} OR description ILIKE $${paramCount} OR plan_id::text ILIKE $${paramCount})`;
      params.push(`%${search}%`);
    }

    const validSortColumns = ['plan_id', 'name', 'price', 'duration', 'active', 'created_at'];
    const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'created_at';
    const sortDirection = sortOrder.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    query += ` ORDER BY ${sortColumn} ${sortDirection} LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);
    
    // Get network from request (vendor's selected network) - use different variable name to avoid conflict
    const vendorNetwork = network || await getNetworkFromRequest(req);
    
    // Enrich plans with billing cycle and renewal count from blockchain
    const contract = await contractService.getContract(vendorNetwork);
    const enrichedPlans = await Promise.all(
      result.rows.map(async (plan) => {
        const durationDays = parseInt(plan.duration) / (24 * 60 * 60);
        let billingCycle = '';
        if (durationDays === 30) billingCycle = 'Monthly';
        else if (durationDays === 90) billingCycle = 'Quarterly';
        else if (durationDays === 365) billingCycle = 'Yearly';
        else billingCycle = `${durationDays} days`;

        return {
          ...plan,
          billingCycle
        };
      })
    );

    let countQuery = `SELECT COUNT(*) FROM subscription_plans WHERE vendor_address = $1`;
    const countParams = [vendorAddress.toLowerCase()];
    if (appId) {
      countQuery += ` AND app_id = $2`;
      countParams.push(appId);
    }
    if (search) {
      countQuery += ` AND (name ILIKE $${countParams.length + 1} OR description ILIKE $${countParams.length + 1} OR plan_id::text ILIKE $${countParams.length + 1})`;
      countParams.push(`%${search}%`);
    }
    const countResult = await pool.query(countQuery, countParams);

    res.json({
      data: enrichedPlans,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(countResult.rows[0].count / limit)
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/vendor/subscribers
 * Get customers who subscribed to vendor's plans
 */
router.get('/subscribers', async (req, res, next) => {
  try {
    const { vendorAddress } = req.query;
    if (!vendorAddress) {
      return res.status(400).json({ error: 'vendorAddress is required' });
    }

    // Extract query parameters - note: 'network' is used here, so we'll use 'vendorNetwork' later to avoid conflicts
    const { page = 1, limit = 25, search = '', sortBy = 'created_at', sortOrder = 'desc', planId, network } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT 
        s.token_id,
        s.subscriber_address,
        s.plan_id,
        s.created_at,
        sp.name as plan_name,
        sp.price as plan_price
      FROM subscriptions s
      INNER JOIN subscription_plans sp ON s.plan_id = sp.plan_id
      WHERE sp.vendor_address = $1
    `;
    const params = [vendorAddress.toLowerCase()];
    let paramCount = 1;

    // Filter by network if provided
    if (network) {
      paramCount++;
      query += ` AND (sp.network = $${paramCount} OR sp.network IS NULL)`;
      params.push(network);
    }

    if (planId) {
      paramCount++;
      query += ` AND s.plan_id = $${paramCount}`;
      params.push(planId);
    }

    if (search) {
      paramCount++;
      query += ` AND (
        s.subscriber_address ILIKE $${paramCount} OR 
        sp.name ILIKE $${paramCount} OR
        s.token_id::text ILIKE $${paramCount}
      )`;
      params.push(`%${search}%`);
    }

    const validSortColumns = ['subscriber_address', 'plan_name', 'created_at'];
    const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'created_at';
    const sortDirection = sortOrder.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    if (sortColumn === 'plan_name') {
      query += ` ORDER BY sp.name ${sortDirection}`;
    } else if (sortColumn === 'subscriber_address') {
      query += ` ORDER BY s.subscriber_address ${sortDirection}`;
    } else {
      query += ` ORDER BY s.created_at ${sortDirection}`;
    }

    query += ` LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);
    
    // Get network from request (vendor's selected network)
    // NOTE: 'network' is already declared above from req.query, so we use 'vendorNetwork' here
    const vendorNetwork = network || await getNetworkFromRequest(req);
    
    // Enrich with blockchain data and status
    const enrichedSubscribers = await Promise.all(
      result.rows.map(async (sub) => {
        try {
          const contract = await contractService.getContract(vendorNetwork);
          const subscription = await contract.getSubscription(sub.token_id);
          const startTime = parseInt(subscription.startTime.toString());
          const endTime = parseInt(subscription.endTime.toString());
          const isValid = subscription.active && endTime > Math.floor(Date.now() / 1000);
          return {
            customerAddress: sub.subscriber_address,
            planName: sub.plan_name,
            planPrice: sub.plan_price || '0',
            subscriptionStart: new Date(startTime * 1000).toISOString(),
            subscriptionEnd: new Date(endTime * 1000).toISOString(),
            status: isValid ? 'active' : 'expired',
            tokenId: sub.token_id,
            paused: subscription.paused,
            published: subscription.published
          };
        } catch (e) {
          console.error(`Error fetching subscription ${sub.token_id} from blockchain:`, e.message);
          return {
            customerAddress: sub.subscriber_address,
            planName: sub.plan_name,
            planPrice: sub.plan_price || '0',
            subscriptionStart: null,
            subscriptionEnd: null,
            status: 'unknown',
            tokenId: sub.token_id,
            paused: false,
            published: true
          };
        }
      })
    );

    // Apply sorting by start_time or end_time if requested (after blockchain enrichment)
    if (sortBy === 'subscriptionStart' || sortBy === 'start_time') {
      enrichedSubscribers.sort((a, b) => {
        const aTime = a.subscriptionStart ? new Date(a.subscriptionStart).getTime() : 0;
        const bTime = b.subscriptionStart ? new Date(b.subscriptionStart).getTime() : 0;
        return sortOrder === 'asc' ? aTime - bTime : bTime - aTime;
      });
    } else if (sortBy === 'subscriptionEnd' || sortBy === 'end_time') {
      enrichedSubscribers.sort((a, b) => {
        const aTime = a.subscriptionEnd ? new Date(a.subscriptionEnd).getTime() : 0;
        const bTime = b.subscriptionEnd ? new Date(b.subscriptionEnd).getTime() : 0;
        return sortOrder === 'asc' ? aTime - bTime : bTime - aTime;
      });
    }

    // Apply pagination after sorting
    const paginatedData = enrichedSubscribers.slice(offset, offset + parseInt(limit));

    let countQuery = `
      SELECT COUNT(*) 
      FROM subscriptions s
      INNER JOIN subscription_plans sp ON s.plan_id = sp.plan_id
      WHERE sp.vendor_address = $1
    `;
    const countParams = [vendorAddress.toLowerCase()];
    let countParamCount = 1;
    
    // Filter by network if provided
    if (network) {
      countParamCount++;
      countQuery += ` AND (sp.network = $${countParamCount} OR sp.network IS NULL)`;
      countParams.push(network);
    }
    
    if (planId) {
      countParamCount++;
      countQuery += ` AND s.plan_id = $${countParamCount}`;
      countParams.push(planId);
    }
    if (search) {
      countParamCount++;
      countQuery += ` AND (s.subscriber_address ILIKE $${countParamCount} OR sp.name ILIKE $${countParamCount} OR s.token_id::text ILIKE $${countParamCount})`;
      countParams.push(`%${search}%`);
    }
    const countResult = await pool.query(countQuery, countParams);

    res.json({
      data: paginatedData,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(countResult.rows[0].count / limit)
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

