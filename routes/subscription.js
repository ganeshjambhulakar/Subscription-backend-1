const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { ethers } = require('ethers');
const contractService = require('../services/contractService');
const ipfsService = require('../services/ipfsService');
const webhookService = require('../services/webhookService');
const { checkMaintenanceMode } = require('../middleware/maintenanceMode');

/**
 * Helper function to safely checksum address without triggering ENS resolution
 * This avoids ENS errors on local networks
 */
function safeGetAddress(address) {
  try {
    // Validate address format first
    if (!ethers.isAddress(address)) {
      return null;
    }
    // Use ethers getAddress on lowercase to avoid ENS resolution
    // getAddress on a valid address (not ENS name) won't trigger ENS lookup
    return ethers.getAddress(address.toLowerCase());
  } catch (e) {
    // If checksumming fails, return lowercase
    return address.toLowerCase();
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Apply maintenance mode middleware to all subscription routes
router.use(checkMaintenanceMode('customer'));

/**
 * GET /api/subscriptions/plans
 * Get subscription plans (supports appId filter)
 * This route must be defined BEFORE /:tokenId to avoid conflicts
 */
router.get('/plans', async (req, res, next) => {
  try {
    const { appId, vendorAddress, network, active } = req.query;
    
    let query = `
      SELECT sp.*, a.name as app_name 
      FROM subscription_plans sp 
      LEFT JOIN apps a ON sp.app_id = a.app_id 
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 1;
    
    if (appId) {
      query += ` AND sp.app_id = $${paramCount++}`;
      params.push(appId);
    }
    
    if (vendorAddress) {
      query += ` AND LOWER(sp.vendor_address) = LOWER($${paramCount++})`;
      params.push(vendorAddress);
    }
    
    if (network) {
      query += ` AND sp.network = $${paramCount++}`;
      params.push(network);
    }
    
    if (active !== undefined) {
      query += ` AND sp.active = $${paramCount++}`;
      params.push(active === 'true' || active === true);
    } else {
      query += ` AND sp.active = true`;
    }
    
    query += ` ORDER BY sp.created_at DESC`;
    
    const result = await pool.query(query, params);
    
    res.json({
      status: 'success',
      data: {
        plans: result.rows.map(plan => ({
          planId: plan.plan_id,
          name: plan.name,
          description: plan.description,
          price: parseFloat(plan.price),
          durationDays: Math.round(plan.duration / 86400),
          duration: plan.duration,
          maxSubscriptions: plan.max_subscriptions,
          active: plan.active,
          appId: plan.app_id,
          appName: plan.app_name,
          vendorAddress: plan.vendor_address,
          network: plan.network,
          features: plan.features || []
        }))
      }
    });
  } catch (error) {
    console.error('[Subscriptions/Plans] Error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

/**
 * GET /api/subscriptions/plan/:planId
 * Get a specific subscription plan by ID
 * Must be defined BEFORE /:tokenId to avoid route conflicts
 */
router.get('/plan/:planId', async (req, res, next) => {
  try {
    const { planId } = req.params;
    
    const query = `
      SELECT sp.*, a.name as app_name 
      FROM subscription_plans sp 
      LEFT JOIN apps a ON sp.app_id = a.app_id 
      WHERE sp.plan_id = $1
    `;
    
    const result = await pool.query(query, [planId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: `Plan ${planId} not found`
      });
    }
    
    const plan = result.rows[0];
    
    res.json({
      status: 'success',
      data: {
        planId: plan.plan_id,
        name: plan.name,
        description: plan.description,
        price: parseFloat(plan.price),
        durationDays: Math.round(plan.duration / 86400),
        duration: plan.duration,
        maxSubscriptions: plan.max_subscriptions,
        active: plan.active,
        appId: plan.app_id,
        appName: plan.app_name,
        vendorAddress: plan.vendor_address,
        network: plan.network,
        features: plan.features || []
      }
    });
  } catch (error) {
    console.error('[Subscriptions/Plan] Error:', error);
    next(error);
  }
});

/**
 * GET /api/subscriptions
 * Get all subscriptions (with optional filters) - enriched with plan and blockchain data
 */
router.get('/', async (req, res, next) => {
  try {
    // Check database connection first
    try {
      await pool.query('SELECT 1');
    } catch (dbError) {
      console.error('[Subscriptions] Database connection error:', dbError);
      return res.status(503).json({ 
        error: 'Database connection failed',
        message: 'Please ensure PostgreSQL is running and DATABASE_URL is configured correctly.'
      });
    }
    
    const { userAddress, planId, vendorAddress } = req.query;
    let query = `
      SELECT s.*, 
             sp.name as plan_name, 
             sp.description as plan_description,
             sp.price as plan_price, 
             sp.duration as plan_duration,
             sp.vendor_address as vendor_address
      FROM subscriptions s
      LEFT JOIN subscription_plans sp ON s.plan_id = sp.plan_id
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 1;
    
    if (userAddress) {
      query += ` AND s.subscriber_address = $${paramCount++}`;
      params.push(userAddress.toLowerCase());
    }
    
    if (planId) {
      query += ` AND s.plan_id = $${paramCount++}`;
      params.push(planId);
    }
    
    if (vendorAddress) {
      query += ` AND sp.vendor_address = $${paramCount++}`;
      params.push(vendorAddress.toLowerCase());
    }
    
    query += ' ORDER BY s.created_at DESC';
    
    const dbResult = await pool.query(query, params);
    
    // Enrich with blockchain data
    const contract = await contractService.getContract();
    const enrichedSubscriptions = [];
    
    for (const sub of dbResult.rows) {
      try {
        const blockchainSub = await contract.getSubscription(sub.token_id);
        const isValid = await contract.isSubscriptionValid(sub.token_id);
        
        // Get plan details from blockchain if available
        let planDetails = null;
        try {
          const plan = await contract.getPlan(blockchainSub.planId.toString());
          planDetails = {
            name: plan.name,
            description: plan.description,
            price: plan.price.toString(),
            duration: plan.duration.toString(),
            pauseEnabled: plan.pauseEnabled,
            maxPauseAttempts: plan.maxPauseAttempts ? plan.maxPauseAttempts.toString() : '0'
          };
        } catch (e) {
          console.warn(`Could not load plan details for plan ${blockchainSub.planId}:`, e);
        }
        
        enrichedSubscriptions.push({
          ...sub,
          tokenId: sub.token_id,
          planId: sub.plan_id,
          subscriber: sub.subscriber_address,
          startTime: blockchainSub.startTime.toString(),
          endTime: blockchainSub.endTime.toString(),
          active: blockchainSub.active,
          isValid: isValid,
          paused: blockchainSub.paused || false,
          pauseAttempts: blockchainSub.pauseAttempts ? parseInt(blockchainSub.pauseAttempts.toString()) : 0,
          published: blockchainSub.published !== undefined ? blockchainSub.published : true,
          planName: sub.plan_name || planDetails?.name || 'Unknown Plan',
          planDescription: sub.plan_description || planDetails?.description || '',
          planPrice: sub.plan_price ? parseFloat(sub.plan_price) : (planDetails?.price ? parseFloat(ethers.formatEther(planDetails.price)) : 0),
          planDuration: sub.plan_duration ? parseInt(sub.plan_duration) : (planDetails?.duration ? parseInt(planDetails.duration) : 0),
          vendorAddress: sub.vendor_address,
          transactionHash: sub.transaction_hash,
          daysRemaining: isValid ? Math.max(0, Math.floor((parseInt(blockchainSub.endTime) - Date.now() / 1000) / 86400)) : 0
        });
      } catch (error) {
        console.error(`Error fetching blockchain data for subscription ${sub.token_id}:`, error);
        // Still include the subscription with database data only
        enrichedSubscriptions.push({
          ...sub,
          tokenId: sub.token_id,
          planId: sub.plan_id,
          subscriber: sub.subscriber_address,
          isValid: false,
          planName: sub.plan_name || 'Unknown Plan',
          planDescription: sub.plan_description || '',
          planPrice: sub.plan_price ? parseFloat(sub.plan_price) : 0,
          planDuration: sub.plan_duration ? parseInt(sub.plan_duration) : 0,
          vendorAddress: sub.vendor_address,
          transactionHash: sub.transaction_hash,
          blockchainError: error.message
        });
      }
    }
    
    res.json(enrichedSubscriptions);
  } catch (error) {
    console.error('[Subscriptions] Error:', error);
    // Ensure response is sent even on error
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal server error',
        message: error.message
      });
    }
  }
});

/**
 * GET /api/subscriptions/:tokenId
 * Get subscription details by token ID
 */
router.get('/:tokenId', async (req, res, next) => {
  try {
    const { tokenId } = req.params;
    
    // Get from database
    const dbResult = await pool.query(
      'SELECT * FROM subscriptions WHERE token_id = $1',
      [tokenId]
    );
    
    // Get from blockchain
    const contract = await contractService.getContract();
    const subscription = await contract.getSubscription(tokenId);
    const isValid = await contract.isSubscriptionValid(tokenId);
    
    const subscriptionData = {
      tokenId: subscription.tokenId.toString(),
      planId: subscription.planId.toString(),
      subscriber: subscription.subscriber,
      startTime: subscription.startTime.toString(),
      endTime: subscription.endTime.toString(),
      active: subscription.active,
      isValid: isValid,
      dbData: dbResult.rows[0] || null
    };
    
    res.json(subscriptionData);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/subscriptions/purchase
 * Purchase a subscription NFT
 */
router.post('/purchase', async (req, res, next) => {
  try {
    const { planId, subscriberAddress, subscriberPrivateKey, metadata } = req.body;
    
    if (!planId || !subscriberAddress || !subscriberPrivateKey) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Upload metadata to IPFS
    let tokenURI = '';
    if (metadata) {
      tokenURI = await ipfsService.uploadMetadata(metadata);
    } else {
      tokenURI = `ipfs://default-${Date.now()}`;
    }
    
    // Get plan details
    const contract = await contractService.getContract();
    const plan = await contract.getPlan(planId);
    
    // Purchase subscription on blockchain
    const provider = contractService.getProvider();
    const wallet = new ethers.Wallet(subscriberPrivateKey, provider);
    const contractWithSigner = contract.connect(wallet);
    
    // Use purchaseSubscription method (matches contract)
    const tx = await contractWithSigner.purchaseSubscription(
      planId,
      tokenURI,
      { value: plan.price }
    );
    
    const receipt = await tx.wait();
    
      // Extract tokenId from event
      const iface = contract.interface;
      const event = receipt.logs.find(log => {
        try {
          const parsed = iface.parseLog(log);
          return parsed && parsed.name === 'SubscriptionPurchased';
        } catch {
          return false;
        }
      });
      
      if (!event) {
        throw new Error('SubscriptionPurchased event not found in transaction receipt');
      }
      
      const parsedEvent = iface.parseLog(event);
      const tokenId = parsedEvent.args.tokenId.toString();
    
    // Get plan details for transaction record
    const planResult = await pool.query(
      'SELECT * FROM subscription_plans WHERE plan_id = $1',
      [planId]
    );
    
    // Save to database with transaction hash
    await pool.query(
      `INSERT INTO subscriptions 
       (token_id, plan_id, subscriber_address, token_uri, transaction_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [tokenId, planId, subscriberAddress.toLowerCase(), tokenURI, receipt.hash]
    );
    
    // Record in subscription history (if table exists and has correct schema)
    try {
      await pool.query(
        `INSERT INTO subscription_history 
         (token_id, subscriber_address, vendor_address, event_type, event_data, transaction_hash, block_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          tokenId,
          subscriberAddress.toLowerCase(),
          planResult.rows[0]?.vendor_address || '',
          'purchased',
          JSON.stringify({ 
            timestamp: new Date().toISOString(),
            planId: planId,
            price: planResult.rows[0]?.price || '0',
            tokenURI
          }),
          receipt.hash,
          receipt.blockNumber
        ]
      );
    } catch (historyError) {
      // If subscription_history table doesn't exist or has different schema, just log and continue
      console.warn('[Subscription Purchase] Could not record in subscription_history:', historyError.message);
    }
    
    // Trigger subscription.purchased webhook (AC2.6)
    try {
      // Get subscription data from blockchain
      const subscription = await contract.getSubscription(tokenId);
      const plan = await contract.getPlan(subscription.planId);
      
      // Try to find API key for vendor
      const vendorAddress = planResult.rows[0]?.vendor_address;
      if (vendorAddress) {
        // Get API key ID from vendor address (try checkout_apps first, then api_keys)
        let apiKeyResult = await pool.query(
          `SELECT id FROM checkout_apps WHERE vendor_address = $1 AND status = 'active' LIMIT 1`,
          [vendorAddress.toLowerCase()]
        );
        
        // Fallback to api_keys table
        if (apiKeyResult.rows.length === 0) {
          apiKeyResult = await pool.query(
            `SELECT id FROM api_keys WHERE vendor_address = $1 AND active = true LIMIT 1`,
            [vendorAddress.toLowerCase()]
          );
        }
        
        if (apiKeyResult.rows.length > 0) {
          const payload = {
            tokenId: tokenId,
            planId: subscription.planId.toString(),
            customerAddress: subscriberAddress.toLowerCase(),
            startTime: subscription.startTime.toString(),
            endTime: subscription.endTime.toString(),
            startTimeISO: new Date(parseInt(subscription.startTime.toString()) * 1000).toISOString(),
            endTimeISO: new Date(parseInt(subscription.endTime.toString()) * 1000).toISOString(),
            transactionHash: receipt.hash,
            purchaseTimestamp: new Date().toISOString(),
            plan: {
              name: plan.name,
              description: plan.description,
              price: plan.price.toString()
            }
          };
          
          webhookService.triggerWebhook(apiKeyResult.rows[0].id, 'subscription.purchased', payload)
            .catch(error => {
              console.error('[Webhook] Error triggering subscription.purchased:', error.message);
            });
        }
      }
    } catch (webhookError) {
      console.warn('[Subscription] Error triggering webhook:', webhookError.message);
    }
    
    res.status(201).json({
      tokenId,
      transactionHash: receipt.hash,
      tokenURI,
      plan: planResult.rows[0] || null,
      message: 'Subscription purchased successfully'
    });
  } catch (error) {
    console.error('Error purchasing subscription:', error);
    next(error);
  }
});

/**
 * POST /api/subscriptions/:tokenId/renew
 * Renew a subscription
 */
router.post('/:tokenId/renew', async (req, res, next) => {
  try {
    const { tokenId } = req.params;
    const { subscriberPrivateKey } = req.body;
    
    if (!subscriberPrivateKey) {
      return res.status(400).json({ error: 'Private key required' });
    }
    
    const contract = await contractService.getContract();
    const subscription = await contract.getSubscription(tokenId);
    const plan = await contract.getPlan(subscription.planId);
    
    const provider = contractService.getProvider();
    const wallet = new ethers.Wallet(subscriberPrivateKey, provider);
    const contractWithSigner = contract.connect(wallet);
    
    const tx = await contractWithSigner.renewSubscription(tokenId, {
      value: plan.price
    });
    
    const receipt = await tx.wait();
    
    // Get updated subscription data
    const updatedSubscription = await contract.getSubscription(tokenId);
    const updatedPlan = await contract.getPlan(updatedSubscription.planId);
    
    // Trigger subscription.renewed webhook (AC2.7)
    try {
      // Get subscription from database to find vendor
      const subResult = await pool.query(
        `SELECT s.*, sp.vendor_address 
         FROM subscriptions s
         LEFT JOIN subscription_plans sp ON s.plan_id = sp.plan_id
         WHERE s.token_id = $1`,
        [tokenId]
      );
      
      if (subResult.rows.length > 0) {
        const vendorAddress = subResult.rows[0].vendor_address;
        
        // Get API key ID from vendor address (try checkout_apps first, then api_keys)
        let apiKeyResult = await pool.query(
          `SELECT id FROM checkout_apps WHERE vendor_address = $1 AND status = 'active' LIMIT 1`,
          [vendorAddress?.toLowerCase()]
        );
        
        // Fallback to api_keys table
        if (apiKeyResult.rows.length === 0) {
          apiKeyResult = await pool.query(
            `SELECT id FROM api_keys WHERE vendor_address = $1 AND active = true LIMIT 1`,
            [vendorAddress?.toLowerCase()]
          );
        }
        
        if (apiKeyResult.rows.length > 0) {
          const previousEndTime = subscription.endTime.toString();
          const newEndTime = updatedSubscription.endTime.toString();
          
          const payload = {
            tokenId: tokenId,
            planId: updatedSubscription.planId.toString(),
            customerAddress: subscription.subscriber.toLowerCase(),
            previousEndTime: previousEndTime,
            previousEndTimeISO: new Date(parseInt(previousEndTime) * 1000).toISOString(),
            newEndTime: newEndTime,
            newEndTimeISO: new Date(parseInt(newEndTime) * 1000).toISOString(),
            renewalTransactionHash: receipt.hash,
            renewalTimestamp: new Date().toISOString(),
            plan: {
              name: updatedPlan.name,
              description: updatedPlan.description,
              price: updatedPlan.price.toString()
            }
          };
          
          webhookService.triggerWebhook(apiKeyResult.rows[0].id, 'subscription.renewed', payload)
            .catch(error => {
              console.error('[Webhook] Error triggering subscription.renewed:', error.message);
            });
        }
      }
    } catch (webhookError) {
      console.warn('[Subscription] Error triggering renewal webhook:', webhookError.message);
    }
    
    res.json({
      transactionHash: receipt.hash,
      message: 'Subscription renewed successfully'
    });
  } catch (error) {
    console.error('Error renewing subscription:', error);
    next(error);
  }
});

/**
 * GET /api/subscriptions/verify/:tokenId
 * Verify if a subscription is valid
 */
router.get('/verify/:tokenId', async (req, res, next) => {
  try {
    const { tokenId } = req.params;
    
    const contract = await contractService.getContract();
    const isValid = await contract.isSubscriptionValid(tokenId);
    const subscription = await contract.getSubscription(tokenId);
    
    res.json({
      tokenId,
      isValid,
      subscription: {
        planId: subscription.planId.toString(),
        subscriber: subscription.subscriber,
        startTime: subscription.startTime.toString(),
        endTime: subscription.endTime.toString(),
        active: subscription.active
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/subscriptions/user/:address
 * Get all subscriptions for a user
 */
router.get('/user/:address', async (req, res, next) => {
  try {
    // Check database connection first
    try {
      await pool.query('SELECT 1');
    } catch (dbError) {
      console.error('[Subscriptions] Database connection error:', dbError);
      return res.status(503).json({ 
        error: 'Database connection failed',
        message: 'Please ensure PostgreSQL is running and DATABASE_URL is configured correctly.'
      });
    }
    
    const { address } = req.params;
    const normalizedAddress = address.toLowerCase();
    
    // Try to get contract, but don't fail if it's not available
    let contract = null;
    try {
      contract = await contractService.getContract();
    } catch (contractError) {
      console.warn('[Subscriptions] Contract not available:', contractError.message);
    }
    
    // First, get all token IDs from blockchain (most reliable source)
    // Try multiple address formats to handle checksummed vs lowercase
    let tokenIds = [];
    if (contract) {
      // Try 1: Original address (might be checksummed)
      try {
        tokenIds = await contract.getUserSubscriptions(address);
        console.log(`[Subscriptions User] Found ${tokenIds.length} subscriptions on blockchain for ${address} (original format)`);
        console.log(`[Subscriptions User] Token IDs:`, tokenIds.map(id => id.toString()));
      } catch (e) {
        // Check if this is an ENS-related error
        if (e.code === 'UNSUPPORTED_OPERATION' && e.operation === 'getEnsAddress') {
          console.warn('[Subscriptions User] ENS not supported on this network, skipping blockchain query');
          // Fall through to database query only
        } else {
          console.warn('[Subscriptions User] Could not get subscriptions with original address:', e.message);
          
          // Try 2: Checksummed address (using safe method)
          try {
            const checksummedAddress = safeGetAddress(address);
            if (checksummedAddress) {
              tokenIds = await contract.getUserSubscriptions(checksummedAddress);
              console.log(`[Subscriptions User] Found ${tokenIds.length} subscriptions using checksummed address`);
            } else {
              throw new Error('Invalid address format');
            }
          } catch (e2) {
            // Check if this is also an ENS error
            if (e2.code === 'UNSUPPORTED_OPERATION' && e2.operation === 'getEnsAddress') {
              console.warn('[Subscriptions User] ENS not supported, skipping blockchain query');
            } else {
              console.warn('[Subscriptions User] Could not get subscriptions with checksummed address:', e2.message);
              
              // Try 3: Normalized (lowercase) address
              try {
                tokenIds = await contract.getUserSubscriptions(normalizedAddress);
                console.log(`[Subscriptions User] Found ${tokenIds.length} subscriptions using normalized address`);
              } catch (e3) {
                // Check if this is also an ENS error
                if (e3.code === 'UNSUPPORTED_OPERATION' && e3.operation === 'getEnsAddress') {
                  console.warn('[Subscriptions User] ENS not supported, skipping blockchain query');
                } else {
                  console.warn('[Subscriptions User] Could not get subscriptions with normalized address:', e3.message);
                }
              }
            }
          }
        }
      }
    }
    
    // Get from database
    const dbResult = await pool.query(
      'SELECT * FROM subscriptions WHERE subscriber_address = $1 ORDER BY created_at DESC',
      [normalizedAddress]
    );
    
    // Create a map of token_id -> database record
    const dbSubscriptionsMap = new Map();
    dbResult.rows.forEach(sub => {
      dbSubscriptionsMap.set(sub.token_id, sub);
    });
    
    // Process all subscriptions (from blockchain, with database data if available)
    const allTokenIds = new Set();
    
    // Add token IDs from blockchain
    tokenIds.forEach(id => allTokenIds.add(id.toString()));
    
    // Add token IDs from database (in case some aren't in blockchain yet)
    dbResult.rows.forEach(sub => allTokenIds.add(sub.token_id));
    
    const subscriptions = await Promise.all(
      Array.from(allTokenIds).map(async (tokenId) => {
        const dbSub = dbSubscriptionsMap.get(tokenId);
        
        // If contract is not available, return database data only
        if (!contract) {
          return {
            ...dbSub,
            tokenId: dbSub?.token_id || tokenId,
            planId: dbSub?.plan_id || null,
            subscriber: dbSub?.subscriber_address || normalizedAddress,
            isValid: false,
            blockchainError: 'Contract service not available'
          };
        }
        
        try {
          if (!contract) {
            throw new Error('Contract service not available');
          }
          
          const blockchainSub = await contract.getSubscription(tokenId);
          const isValid = await contract.isSubscriptionValid(tokenId);
          
          // Get plan details
          let planDetails = null;
          try {
            const plan = await contract.getPlan(blockchainSub.planId.toString());
            planDetails = {
              name: plan.name,
              description: plan.description,
              price: plan.price.toString(),
              duration: plan.duration.toString()
            };
          } catch (e) {
            console.warn(`Could not load plan details for plan ${blockchainSub.planId}:`, e);
          }
          
          // Also try to get plan from database
          let planFromDb = null;
          try {
            const planResult = await pool.query(
              'SELECT * FROM subscription_plans WHERE plan_id = $1',
              [blockchainSub.planId.toString()]
            );
            if (planResult.rows.length > 0) {
              planFromDb = planResult.rows[0];
            }
          } catch (e) {
            console.warn(`Could not load plan from database:`, e);
          }
          
          // If subscription not in database, save it
          if (!dbSub) {
            try {
              await pool.query(
                `INSERT INTO subscriptions 
                 (token_id, plan_id, subscriber_address, token_uri, created_at)
                 VALUES ($1, $2, $3, $4, NOW())
                 ON CONFLICT (token_id) DO NOTHING`,
                [
                  tokenId,
                  blockchainSub.planId.toString(),
                  normalizedAddress,
                  `ipfs://subscription-${tokenId}`
                ]
              );
            } catch (e) {
              console.warn(`Could not save subscription to database:`, e);
            }
          }
          
          return {
            ...(dbSub || {}),
            tokenId: tokenId,
            token_id: tokenId,
            planId: blockchainSub.planId.toString(),
            plan_id: blockchainSub.planId.toString(),
            subscriber: blockchainSub.subscriber,
            subscriber_address: normalizedAddress,
            startTime: blockchainSub.startTime.toString(),
            endTime: blockchainSub.endTime.toString(),
            active: blockchainSub.active,
            isValid,
            paused: blockchainSub.paused || false,
            pauseAttempts: blockchainSub.pauseAttempts ? parseInt(blockchainSub.pauseAttempts.toString()) : 0,
            published: blockchainSub.published !== undefined ? blockchainSub.published : true,
            planName: planDetails?.name || planFromDb?.name || null,
            planDescription: planDetails?.description || planFromDb?.description || null,
            planPrice: planDetails?.price ? (typeof planDetails.price === 'string' ? parseFloat(planDetails.price) : parseFloat(ethers.formatEther(planDetails.price))) : (planFromDb?.price ? parseFloat(planFromDb.price) : null),
            planDuration: planDetails?.duration ? parseInt(planDetails.duration) : (planFromDb?.duration ? parseInt(planFromDb.duration) : null)
          };
        } catch (e) {
          console.warn(`Error loading blockchain data for token ${tokenId}:`, e);
          
          // If we have database record, return it even if blockchain fails
          if (dbSub) {
            // Try to get plan from database
            let planFromDb = null;
            try {
              const planResult = await pool.query(
                'SELECT * FROM subscription_plans WHERE plan_id = $1',
                [dbSub.plan_id]
              );
              if (planResult.rows.length > 0) {
                planFromDb = planResult.rows[0];
              }
            } catch (dbError) {
              console.warn(`Could not load plan from database:`, dbError);
            }
            
            return {
              ...dbSub,
              tokenId: dbSub.token_id,
              isValid: false,
              planName: planFromDb?.name || null,
              planDescription: planFromDb?.description || null,
              planPrice: planFromDb?.price ? parseFloat(planFromDb.price) : null,
              planDuration: planFromDb?.duration ? parseInt(planFromDb.duration) : null
            };
          }
          
          // Return minimal data if both blockchain and database fail
          return {
            tokenId: tokenId,
            token_id: tokenId,
            subscriber_address: normalizedAddress,
            isValid: false,
            planName: null,
            planDescription: null,
            planPrice: null,
            planDuration: null
          };
        }
      })
    );
    
    console.log(`[Subscriptions User] Returning ${subscriptions.length} subscriptions for ${address} (normalized: ${normalizedAddress})`);
    if (subscriptions.length > 0) {
      console.log(`[Subscriptions User] Subscription token IDs:`, subscriptions.map(s => s.tokenId || s.token_id).filter(Boolean));
    }
    res.json(subscriptions);
  } catch (error) {
    console.error('[Subscriptions User] Error:', error);
    // Ensure response is sent even on error
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal server error',
        message: error.message
      });
    }
  }
});

/**
 * POST /api/subscriptions/:tokenId/pause
 * Record a pause event
 */
router.post('/:tokenId/pause', async (req, res, next) => {
  try {
    const { tokenId } = req.params;
    const { transactionHash, blockNumber } = req.body;
    
    // Get subscription details
    const subResult = await pool.query(
      'SELECT s.*, p.vendor_address FROM subscriptions s JOIN subscription_plans p ON s.plan_id = p.plan_id WHERE s.token_id = $1',
      [tokenId]
    );
    
    if (subResult.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }
    
    const sub = subResult.rows[0];
    
    // Update subscription paused status
    await pool.query(
      'UPDATE subscriptions SET paused = true, pause_attempts = pause_attempts + 1, updated_at = NOW() WHERE token_id = $1',
      [tokenId]
    );
    
    // Record in history
    await pool.query(
      `INSERT INTO subscription_history 
       (token_id, plan_id, subscriber_address, vendor_address, event_type, event_data, transaction_hash, block_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        tokenId,
        sub.plan_id,
        sub.subscriber_address,
        sub.vendor_address,
        'paused',
        JSON.stringify({ timestamp: new Date().toISOString() }),
        transactionHash,
        blockNumber
      ]
    );
    
    res.json({ message: 'Pause event recorded', tokenId });
  } catch (error) {
    console.error('Error recording pause:', error);
    next(error);
  }
});

/**
 * POST /api/subscriptions/:tokenId/unpause
 * Record an unpause event
 */
router.post('/:tokenId/unpause', async (req, res, next) => {
  try {
    const { tokenId } = req.params;
    const { transactionHash, blockNumber } = req.body;
    
    // Get subscription details
    const subResult = await pool.query(
      'SELECT s.*, p.vendor_address FROM subscriptions s JOIN subscription_plans p ON s.plan_id = p.plan_id WHERE s.token_id = $1',
      [tokenId]
    );
    
    if (subResult.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }
    
    const sub = subResult.rows[0];
    
    // Get blockchain data to get pause duration
    const contract = await contractService.getContract();
    const blockchainSub = await contract.getSubscription(tokenId);
    
    // Update subscription paused status
    await pool.query(
      'UPDATE subscriptions SET paused = false, total_paused_time = total_paused_time + EXTRACT(EPOCH FROM (NOW() - created_at))::INTEGER, updated_at = NOW() WHERE token_id = $1',
      [tokenId]
    );
    
    // Record in history
    await pool.query(
      `INSERT INTO subscription_history 
       (token_id, plan_id, subscriber_address, vendor_address, event_type, event_data, transaction_hash, block_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        tokenId,
        sub.plan_id,
        sub.subscriber_address,
        sub.vendor_address,
        'unpaused',
        JSON.stringify({ 
          timestamp: new Date().toISOString(),
          totalPausedTime: blockchainSub.totalPausedTime ? blockchainSub.totalPausedTime.toString() : '0'
        }),
        transactionHash,
        blockNumber
      ]
    );
    
    res.json({ message: 'Unpause event recorded', tokenId });
  } catch (error) {
    console.error('Error recording unpause:', error);
    next(error);
  }
});

/**
 * GET /api/subscriptions/history/:tokenId
 * Get subscription history
 */
router.get('/history/:tokenId', async (req, res, next) => {
  try {
    const { tokenId } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM subscription_history WHERE token_id = $1 ORDER BY created_at DESC',
      [tokenId]
    );
    
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/subscriptions/history/vendor/:vendorAddress
 * Get all subscription history for a vendor
 */
router.get('/history/vendor/:vendorAddress', async (req, res, next) => {
  try {
    const { vendorAddress } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM subscription_history WHERE vendor_address = $1 ORDER BY created_at DESC',
      [vendorAddress.toLowerCase()]
    );
    
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

module.exports = router;

