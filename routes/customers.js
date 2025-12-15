const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { ethers } = require('ethers');
const contractService = require('../services/contractService');
const { checkMaintenanceMode } = require('../middleware/maintenanceMode');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Apply maintenance mode middleware to all customer routes
router.use(checkMaintenanceMode('customer'));

/**
 * GET /api/customers/vendor/:vendorAddress
 * Get all customers who purchased from a vendor
 */
router.get('/vendor/:vendorAddress', async (req, res, next) => {
  try {
    const { vendorAddress } = req.params;
    const normalizedVendorAddress = vendorAddress.toLowerCase();
    
    // Get all plans for this vendor from database
    const plansResult = await pool.query(
      'SELECT plan_id FROM subscription_plans WHERE vendor_address = $1',
      [normalizedVendorAddress]
    );
    
    const planIds = plansResult.rows.map(row => row.plan_id);
    
    // Get blockchain contract to query plans and subscriptions
    const contract = await contractService.getContract();
    
    // Also get vendor plans from blockchain (in case some plans aren't in database)
    let blockchainPlanIds = [];
    try {
      // Get all vendor plans from blockchain
      const blockchainPlans = await contract.getVendorPlans(normalizedVendorAddress);
      blockchainPlanIds = blockchainPlans.map(p => p.toString());
      
      // Merge with database plan IDs
      const allPlanIds = [...new Set([...planIds, ...blockchainPlanIds])];
      
      // If we have blockchain plans not in database, sync them
      for (const planId of blockchainPlanIds) {
        if (!planIds.includes(planId)) {
          try {
            const blockchainPlan = await contract.getPlan(planId);
            // Try to sync plan to database (if it doesn't exist)
            await pool.query(
              `INSERT INTO subscription_plans 
               (plan_id, vendor_address, name, description, price, duration, active, network)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT (plan_id) DO NOTHING`,
              [
                planId,
                blockchainPlan.vendor.toLowerCase(),
                blockchainPlan.name,
                blockchainPlan.description,
                blockchainPlan.price.toString(),
                blockchainPlan.duration.toString(),
                blockchainPlan.active,
                'localhost' // Default network
              ]
            );
          } catch (syncError) {
            console.warn(`Could not sync plan ${planId} to database:`, syncError.message);
          }
        }
      }
    } catch (blockchainError) {
      console.warn('Could not get vendor plans from blockchain:', blockchainError.message);
    }
    
    // Get all subscriptions for these plans from database (use LEFT JOIN to include subscriptions even if plan not in DB)
    // Also include blockchain plan IDs in the query
    const allPlanIdsForQuery = [...new Set([...planIds, ...blockchainPlanIds])];
    const subscriptionsResult = await pool.query(
      `SELECT s.*, 
              COALESCE(sp.name, 'Unknown Plan') as plan_name, 
              COALESCE(sp.price, '0') as plan_price, 
              COALESCE(sp.duration, '0') as plan_duration,
              COALESCE(sp.vendor_address, '') as plan_vendor_address
       FROM subscriptions s
       LEFT JOIN subscription_plans sp ON s.plan_id = sp.plan_id
       WHERE s.plan_id = ANY($1::text[])
       ORDER BY s.created_at DESC`,
      [allPlanIdsForQuery.length > 0 ? allPlanIdsForQuery : ['0']] // Use ['0'] if no plans to avoid SQL error
    );
    
    // Also query blockchain for subscriptions that might not be in database
    // Get all subscriptions from blockchain and filter by plan vendor
    const blockchainSubscriptions = [];
    try {
      // Get all subscriptions from blockchain by checking each plan
      for (const planId of blockchainPlanIds.length > 0 ? blockchainPlanIds : planIds) {
        try {
          const blockchainPlan = await contract.getPlan(planId);
          // Only process if plan belongs to this vendor
          if (blockchainPlan.vendor.toLowerCase() === normalizedVendorAddress) {
            // Get plan's subscriptions from blockchain (we need to check all user subscriptions)
            // This is expensive, so we'll do it differently - check database subscriptions first
          }
        } catch (planError) {
          // Plan doesn't exist, skip
          continue;
        }
      }
    } catch (blockchainSubError) {
      console.warn('Could not get blockchain subscriptions:', blockchainSubError.message);
    }
    
    // Get blockchain data for each subscription and verify plan vendor
    const customersMap = new Map();
    
    for (const sub of subscriptionsResult.rows) {
      const customerAddress = sub.subscriber_address.toLowerCase();
      
      if (!customersMap.has(customerAddress)) {
        customersMap.set(customerAddress, {
          customerAddress: customerAddress,
          totalSubscriptions: 0,
          activeSubscriptions: 0,
          expiredSubscriptions: 0,
          totalSpent: '0',
          subscriptions: [],
          firstPurchaseDate: sub.created_at,
          lastPurchaseDate: sub.created_at
        });
      }
      
      const customer = customersMap.get(customerAddress);
      
      // Get blockchain subscription data and verify plan vendor
      let blockchainData = null;
      let planVendorMatches = false;
      try {
        const subscription = await contract.getSubscription(sub.token_id);
        const isValid = await contract.isSubscriptionValid(sub.token_id);
        
        // Get plan from blockchain to verify vendor
        const blockchainPlan = await contract.getPlan(subscription.planId.toString());
        planVendorMatches = blockchainPlan.vendor.toLowerCase() === normalizedVendorAddress;
        
        blockchainData = {
          tokenId: subscription.tokenId.toString(),
          planId: subscription.planId.toString(),
          subscriber: subscription.subscriber,
          startTime: subscription.startTime.toString(),
          endTime: subscription.endTime.toString(),
          active: subscription.active,
          isValid: isValid,
          planVendor: blockchainPlan.vendor.toLowerCase()
        };
        
        // If plan vendor doesn't match, skip this subscription
        if (!planVendorMatches) {
          console.log(`Skipping subscription ${sub.token_id} - plan vendor ${blockchainPlan.vendor.toLowerCase()} doesn't match ${normalizedVendorAddress}`);
          continue;
        }
      } catch (error) {
        console.error(`Error fetching blockchain data for token ${sub.token_id}:`, error);
        // If we can't verify from blockchain, use database vendor_address if available
        if (sub.plan_vendor_address && sub.plan_vendor_address.toLowerCase() !== normalizedVendorAddress) {
          console.log(`Skipping subscription ${sub.token_id} - database plan vendor doesn't match`);
          continue;
        }
      }
      
      const subscriptionData = {
        ...sub,
        blockchain: blockchainData,
        status: blockchainData?.isValid ? 'active' : 'expired',
        daysRemaining: blockchainData ? Math.max(0, Math.floor((parseInt(blockchainData.endTime) - Date.now() / 1000) / 86400)) : 0
      };
      
      customer.subscriptions.push(subscriptionData);
      customer.totalSubscriptions++;
      
      if (subscriptionData.status === 'active') {
        customer.activeSubscriptions++;
      } else {
        customer.expiredSubscriptions++;
      }
      
      // Calculate total spent - use blockchain plan price if available, otherwise database price
      let spent = parseFloat(sub.plan_price || '0');
      if (blockchainData && blockchainData.planId) {
        try {
          const blockchainPlan = await contract.getPlan(blockchainData.planId);
          spent = parseFloat(ethers.formatEther(blockchainPlan.price));
        } catch (priceError) {
          // Use database price
        }
      }
      customer.totalSpent = (parseFloat(customer.totalSpent) + spent).toString();
      
      // Update dates
      if (new Date(sub.created_at) < new Date(customer.firstPurchaseDate)) {
        customer.firstPurchaseDate = sub.created_at;
      }
      if (new Date(sub.created_at) > new Date(customer.lastPurchaseDate)) {
        customer.lastPurchaseDate = sub.created_at;
      }
    }
    
    // Also check blockchain for subscriptions that might not be in database
    // Query blockchain directly for all subscriptions belonging to this vendor's plans
    try {
      // Get all plan IDs (from database and blockchain)
      const allPlanIds = [...new Set([...planIds, ...blockchainPlanIds])];
      
      if (allPlanIds.length > 0) {
        // Get all unique subscriber addresses from database
        const dbSubscribersResult = await pool.query(
          `SELECT DISTINCT subscriber_address FROM subscriptions`
        );
        const dbSubscribers = new Set(dbSubscribersResult.rows.map(r => r.subscriber_address.toLowerCase()));
        
        // Also query blockchain events to find subscribers who purchased but aren't in database
        // Query SubscriptionPurchased events for this vendor's plans
        const blockchainSubscribersFromEvents = new Set();
        try {
          // Get SubscriptionPurchased events filtered by plan IDs
          const filter = contract.filters.SubscriptionPurchased();
          // Query recent blocks (last 10000 blocks, or from contract deployment)
          const currentBlock = await contract.runner.provider.getBlockNumber();
          const fromBlock = Math.max(0, currentBlock - 10000);
          
          const events = await contract.queryFilter(filter, fromBlock, currentBlock);
          console.log(`[Customer List] Found ${events.length} SubscriptionPurchased events`);
          
          for (const event of events) {
            try {
              const eventPlanId = event.args.planId.toString();
              // Check if this plan belongs to our vendor
              if (allPlanIds.includes(eventPlanId)) {
                const plan = await contract.getPlan(eventPlanId);
                if (plan.vendor.toLowerCase() === normalizedVendorAddress) {
                  const subscriber = event.args.subscriber.toLowerCase();
                  blockchainSubscribersFromEvents.add(subscriber);
                  console.log(`[Customer List] Found blockchain subscriber ${subscriber} for plan ${eventPlanId} (Token ${event.args.tokenId.toString()})`);
                }
              }
            } catch (eventError) {
              // Skip this event
              continue;
            }
          }
        } catch (eventQueryError) {
          console.warn('[Customer List] Could not query SubscriptionPurchased events:', eventQueryError.message);
        }
        
        // Combine database and blockchain subscribers
        const allSubscribersToCheck = new Set([...dbSubscribers, ...blockchainSubscribersFromEvents]);
        console.log(`[Customer List] Checking ${allSubscribersToCheck.size} subscribers (${dbSubscribers.size} from DB, ${blockchainSubscribersFromEvents.size} from blockchain events)`);
        
        // For each subscriber (from database and blockchain events), check their blockchain subscriptions
        for (const subscriberAddress of allSubscribersToCheck) {
          try {
            const tokenIds = await contract.getUserSubscriptions(subscriberAddress);
            
            for (const tokenId of tokenIds) {
              try {
                const subscription = await contract.getSubscription(tokenId.toString());
                const plan = await contract.getPlan(subscription.planId.toString());
                
                // Only include if plan vendor matches
                if (plan.vendor.toLowerCase() === normalizedVendorAddress) {
                  const tokenIdStr = tokenId.toString();
                  const customerAddress = subscription.subscriber.toLowerCase();
                  
                  // Check if we already processed this subscription
                  let alreadyProcessed = false;
                  if (customersMap.has(customerAddress)) {
                    const customer = customersMap.get(customerAddress);
                    alreadyProcessed = customer.subscriptions.some(s => 
                      s.token_id === tokenIdStr || s.blockchain?.tokenId === tokenIdStr
                    );
                  }
                  
                  if (!alreadyProcessed) {
                    // This subscription belongs to this vendor but wasn't in our initial query
                    // Add it to the customer list
                    if (!customersMap.has(customerAddress)) {
                      customersMap.set(customerAddress, {
                        customerAddress: customerAddress,
                        totalSubscriptions: 0,
                        activeSubscriptions: 0,
                        expiredSubscriptions: 0,
                        totalSpent: '0',
                        subscriptions: [],
                        firstPurchaseDate: null,
                        lastPurchaseDate: null
                      });
                    }
                    
                    const customer = customersMap.get(customerAddress);
                    const isValid = await contract.isSubscriptionValid(tokenId.toString());
                    
                    const subscriptionData = {
                      token_id: tokenIdStr,
                      plan_id: subscription.planId.toString(),
                      subscriber_address: customerAddress,
                      plan_name: plan.name,
                      plan_price: ethers.formatEther(plan.price),
                      plan_duration: plan.duration.toString(),
                      created_at: new Date(parseInt(subscription.startTime.toString()) * 1000).toISOString(),
                      blockchain: {
                        tokenId: tokenIdStr,
                        planId: subscription.planId.toString(),
                        subscriber: subscription.subscriber,
                        startTime: subscription.startTime.toString(),
                        endTime: subscription.endTime.toString(),
                        active: subscription.active,
                        isValid: isValid,
                        planVendor: plan.vendor.toLowerCase()
                      },
                      status: isValid ? 'active' : 'expired',
                      daysRemaining: isValid ? Math.max(0, Math.floor((parseInt(subscription.endTime) - Date.now() / 1000) / 86400)) : 0
                    };
                    
                    customer.subscriptions.push(subscriptionData);
                    customer.totalSubscriptions++;
                    
                    if (subscriptionData.status === 'active') {
                      customer.activeSubscriptions++;
                    } else {
                      customer.expiredSubscriptions++;
                    }
                    
                    const spent = parseFloat(ethers.formatEther(plan.price));
                    customer.totalSpent = (parseFloat(customer.totalSpent) + spent).toString();
                    
                    const purchaseDate = new Date(parseInt(subscription.startTime.toString()) * 1000).toISOString();
                    if (!customer.firstPurchaseDate || purchaseDate < customer.firstPurchaseDate) {
                      customer.firstPurchaseDate = purchaseDate;
                    }
                    if (!customer.lastPurchaseDate || purchaseDate > customer.lastPurchaseDate) {
                      customer.lastPurchaseDate = purchaseDate;
                    }
                    
                    // Try to save subscription to database if missing
                    try {
                      await pool.query(
                        `INSERT INTO subscriptions 
                         (token_id, plan_id, subscriber_address, token_uri, created_at)
                         VALUES ($1, $2, $3, $4, $5)
                         ON CONFLICT (token_id) DO NOTHING`,
                        [
                          tokenIdStr,
                          subscription.planId.toString(),
                          customerAddress,
                          `ipfs://subscription-${tokenIdStr}`,
                          purchaseDate
                        ]
                      );
                      console.log(`[Customer List] Synced subscription ${tokenIdStr} to database for customer ${customerAddress}`);
                    } catch (dbError) {
                      console.warn(`Could not save subscription ${tokenIdStr} to database:`, dbError.message);
                    }
                  }
                }
              } catch (subError) {
                // Skip this subscription
                continue;
              }
            }
          } catch (userError) {
            // Skip this user
            continue;
          }
        }
        
        // Also check blockchain for subscriptions that might not be linked to any database subscriber
        // This handles the case where subscription exists on blockchain but subscriber is not in database
        // We'll query by checking each plan's current subscriptions
        for (const planId of allPlanIds) {
          try {
            const plan = await contract.getPlan(planId);
            if (plan.vendor.toLowerCase() === normalizedVendorAddress && plan.currentSubscriptions > 0) {
              // Plan has subscriptions, but we need to find them
              // Since we can't directly query "all subscriptions for a plan", we'll rely on
              // the database subscribers we already checked above
              // If subscription is missing, it will be caught when user queries their subscriptions
            }
          } catch (planError) {
            continue;
          }
        }
      }
    } catch (blockchainQueryError) {
      console.warn('Could not query blockchain for additional subscriptions:', blockchainQueryError.message);
    }
    
    // Convert map to array
    const customers = Array.from(customersMap.values());
    
    res.json(customers);
  } catch (error) {
    console.error('Error fetching vendor customers:', error);
    next(error);
  }
});

/**
 * GET /api/customers/vendor/:vendorAddress/customer/:customerAddress
 * Get detailed information about a specific customer
 */
router.get('/vendor/:vendorAddress/customer/:customerAddress', async (req, res, next) => {
  try {
    const { vendorAddress, customerAddress } = req.params;
    
    // Get all plans for this vendor
    const plansResult = await pool.query(
      'SELECT plan_id FROM subscription_plans WHERE vendor_address = $1',
      [vendorAddress.toLowerCase()]
    );
    
    const planIds = plansResult.rows.map(row => row.plan_id);
    
    if (planIds.length === 0) {
      return res.status(404).json({ error: 'No plans found for this vendor' });
    }
    
    // Get all subscriptions for this customer from this vendor
    const subscriptionsResult = await pool.query(
      `SELECT s.*, sp.name as plan_name, sp.description as plan_description, 
              sp.price as plan_price, sp.duration as plan_duration, sp.vendor_address
       FROM subscriptions s
       JOIN subscription_plans sp ON s.plan_id = sp.plan_id
       WHERE s.plan_id = ANY($1::text[]) AND s.subscriber_address = $2
       ORDER BY s.created_at DESC`,
      [planIds, customerAddress.toLowerCase()]
    );
    
    if (subscriptionsResult.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    // Get blockchain data
    const contract = await contractService.getContract();
    const subscriptions = [];
    
    for (const sub of subscriptionsResult.rows) {
      try {
        const subscription = await contract.getSubscription(sub.token_id);
        const isValid = await contract.isSubscriptionValid(sub.token_id);
        const plan = await contract.getPlan(subscription.planId);
        
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
        console.error(`Error fetching blockchain data:`, error);
        subscriptions.push({
          ...sub,
          blockchain: null,
          status: 'unknown'
        });
      }
    }
    
    // Calculate customer stats
    const activeSubs = subscriptions.filter(s => s.status === 'active');
    const expiredSubs = subscriptions.filter(s => s.status === 'expired');
    const totalSpent = subscriptions.reduce((sum, s) => sum + parseFloat(s.plan_price || '0'), 0);
    
    const customerProfile = {
      customerAddress: customerAddress.toLowerCase(),
      totalSubscriptions: subscriptions.length,
      activeSubscriptions: activeSubs.length,
      expiredSubscriptions: expiredSubs.length,
      totalSpent: totalSpent.toString(),
      firstPurchaseDate: subscriptions[subscriptions.length - 1]?.created_at,
      lastPurchaseDate: subscriptions[0]?.created_at,
      subscriptions: subscriptions
    };
    
    res.json(customerProfile);
  } catch (error) {
    console.error('Error fetching customer details:', error);
    next(error);
  }
});

module.exports = router;

