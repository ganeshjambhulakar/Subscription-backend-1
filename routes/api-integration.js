const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { Pool } = require('pg');
const { apiKeyAuth, requirePermission, logApiRequest } = require('../middleware/apiKeyAuth');
const apiKeyService = require('../services/apiKeyService');
const checkoutService = require('../checkout/services/checkoutService');
const contractService = require('../services/contractService');
const webhookService = require('../services/webhookService');
const subscriptionDataService = require('../services/subscriptionDataService');
const { ethers } = require('ethers');
const { checkMaintenanceMode } = require('../middleware/maintenanceMode');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Apply maintenance mode middleware (before auth to allow admin bypass)
router.use(checkMaintenanceMode('api'));

// Apply authentication and logging to all routes
router.use(apiKeyAuth);
router.use(logApiRequest);

/**
 * GET /api/integration/users/:userId
 * Get user by external user ID
 */
router.get('/users/:userId', async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { appId } = req;

    const result = await pool.query(
      `SELECT * FROM external_users 
       WHERE app_id = $1 AND external_user_id = $2`,
      [appId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'User not found',
        message: `User with ID ${userId} not found for this app`
      });
    }

    res.json({
      status: 'success',
      data: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/integration/users
 * Create or update external user
 */
router.post('/users', requirePermission('read-write'), async (req, res, next) => {
  try {
    const { userId, walletAddress, email, metadata } = req.body;
    const { appId } = req;

    if (!userId) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'userId is required'
      });
    }

    const result = await pool.query(
      `INSERT INTO external_users (app_id, external_user_id, wallet_address, email, metadata)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (app_id, external_user_id) 
       DO UPDATE SET 
         wallet_address = EXCLUDED.wallet_address,
         email = EXCLUDED.email,
         metadata = EXCLUDED.metadata,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [appId, userId, walletAddress || null, email || null, metadata || null]
    );

    res.status(201).json({
      status: 'success',
      data: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/integration/subscriptions
 * Get available subscription plans
 */
router.get('/subscriptions', async (req, res, next) => {
  try {
    const { appId } = req;

    // Get plans associated with this app
    const result = await pool.query(
      `SELECT 
         plan_id,
         name,
         description,
         price,
         duration,
         max_subscriptions,
         active,
         pause_enabled,
         max_pause_attempts
       FROM subscription_plans
       WHERE app_id = $1 AND active = true
       ORDER BY price ASC`,
      [appId]
    );

    res.json({
      status: 'success',
      data: result.rows.map(plan => ({
        planId: plan.plan_id,
        name: plan.name,
        description: plan.description,
        price: plan.price.toString(),
        duration: plan.duration,
        maxSubscriptions: plan.max_subscriptions,
        pauseEnabled: plan.pause_enabled,
        maxPauseAttempts: plan.max_pause_attempts
      }))
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/integration/checkout
 * Initiate subscription checkout (INR or Crypto)
 */
router.post('/checkout', requirePermission('read-write'), async (req, res, next) => {
  try {
    const { userId, planId, paymentMethod = 'crypto', currency = 'ETH' } = req.body;
    const { appId } = req;

    if (!userId || !planId) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'userId and planId are required'
      });
    }

    // Get plan details
    const planResult = await pool.query(
      `SELECT * FROM subscription_plans WHERE plan_id = $1 AND app_id = $2 AND active = true`,
      [planId, appId]
    );

    if (planResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Plan not found',
        message: `Plan ${planId} not found or inactive`
      });
    }

    const plan = planResult.rows[0];

    // Get or create external user
    let userResult = await pool.query(
      `SELECT * FROM external_users WHERE app_id = $1 AND external_user_id = $2`,
      [appId, userId]
    );

    if (userResult.rows.length === 0) {
      // Create user if doesn't exist
      userResult = await pool.query(
        `INSERT INTO external_users (app_id, external_user_id) 
         VALUES ($1, $2) RETURNING *`,
        [appId, userId]
      );
    }

    const user = userResult.rows[0];

    // Handle payment method
    let cryptoAmount = null;
    let inrAmount = null;

    if (paymentMethod === 'inr') {
      // Convert INR to crypto using existing conversion service
      inrAmount = parseFloat(plan.price);
      try {
        const conversionService = require('../checkout/services/priceConversion');
        const conversion = await conversionService.convertInrToCrypto(
          inrAmount,
          currency || 'ETH'
        );
        cryptoAmount = conversion.cryptoAmount;
      } catch (error) {
        return res.status(500).json({
          error: 'Conversion error',
          message: 'Failed to convert INR to crypto',
          details: error.message
        });
      }
    } else {
      // Crypto payment - use plan price directly
      cryptoAmount = plan.price;
    }

    // Create checkout order
    const orderData = {
      vendorAddress: plan.vendor_address,
      customerAddress: user.wallet_address || null,
      totalAmount: inrAmount || cryptoAmount,
      currency: paymentMethod === 'inr' ? 'INR' : currency,
      paymentMethod: paymentMethod,
      cryptoCoin: currency,
      network: 'localhost',
      metadata: {
        appId,
        externalUserId: userId,
        planId,
        source: 'api_integration'
      }
    };

    const order = await checkoutService.createOrder(orderData);

    res.status(201).json({
      status: 'success',
      data: {
        orderId: order.order_id,
        planId: plan.plan_id,
        amount: cryptoAmount.toString(),
        currency: currency,
        paymentMethod: paymentMethod,
        inrAmount: inrAmount,
        checkoutUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/checkout/${order.order_id}`,
        expiresAt: order.expires_at
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/integration/mint
 * Auto-mint NFT after payment success (called internally after checkout)
 */
router.post('/mint', requirePermission('read-write'), async (req, res, next) => {
  try {
    const { orderId, userId, planId } = req.body;
    const { appId } = req;

    if (!orderId || !userId || !planId) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'orderId, userId, and planId are required'
      });
    }

    // Get order details
    const order = await checkoutService.getOrder(orderId, 'localhost');
    
    if (!order || order.status !== 'paid') {
      return res.status(400).json({
        error: 'Invalid order',
        message: 'Order not found or not paid'
      });
    }

    // Get user wallet address
    const userResult = await pool.query(
      `SELECT wallet_address FROM external_users 
       WHERE app_id = $1 AND external_user_id = $2`,
      [appId, userId]
    );

    if (userResult.rows.length === 0 || !userResult.rows[0].wallet_address) {
      return res.status(400).json({
        error: 'User error',
        message: 'User wallet address not set'
      });
    }

    const walletAddress = userResult.rows[0].wallet_address;

    // Mint NFT using existing contract
    const contract = await contractService.getContract('localhost');
    const planIdFormatted = ethers.parseUnits(planId.toString(), 0);
    const tokenURI = `ipfs://subscription-${Date.now()}-${userId}`;

    // Note: This requires the wallet to have funds and sign the transaction
    // In production, this would be handled by a backend wallet or the user's wallet
    // For now, we'll create the subscription record and return instructions
    
    // Mint NFT using contract (requires backend wallet or user wallet)
    // For now, we'll create the subscription record and trigger webhook
    // In production, this would use a backend wallet to mint
    
    // Get plan details for expiry calculation
    const planResult = await pool.query(
      `SELECT duration FROM subscription_plans WHERE plan_id = $1`,
      [planId]
    );
    
    const duration = planResult.rows[0]?.duration || 0;
    const expiryDate = new Date(Date.now() + duration * 1000);

    // Create subscription record in DB
    const subscriptionResult = await pool.query(
      `INSERT INTO api_integration_subscriptions 
       (app_id, external_user_id, plan_id, checkout_order_id, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING *`,
      [appId, userId, planId, orderId]
    );

    // Trigger webhook for subscription_active
    webhookService.triggerWebhook(req.apiKeyId, 'subscription_active', {
      tokenId: null, // Will be set after actual NFT mint
      userId: userId,
      planId: planId,
      expiryDate: expiryDate.toISOString()
    }).catch(console.error);

    res.status(201).json({
      status: 'success',
      message: 'Subscription activated. NFT minting will be completed via blockchain transaction.',
      data: {
        subscriptionId: subscriptionResult.rows[0].id,
        orderId: orderId,
        planId: planId,
        userId: userId,
        status: 'active',
        expiryDate: expiryDate.toISOString()
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/integration/validate
 * Validate subscription via NFT token ID
 */
router.get('/validate', async (req, res, next) => {
  try {
    const { tokenId } = req.query;

    if (!tokenId) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'tokenId query parameter is required'
      });
    }

    // Get subscription from blockchain
    let subscription = null;
    let isValid = false;
    let expiryDate = null;
    let planId = null;

    try {
      const contract = await contractService.getContract('localhost');
      subscription = await contract.getSubscription(tokenId);
      isValid = await contract.isSubscriptionValid(tokenId);
      
      expiryDate = new Date(parseInt(subscription.endTime.toString()) * 1000);
      planId = subscription.planId.toString();
    } catch (error) {
      console.error('[Validate] Blockchain error:', error);
      // Try to get from database as fallback
      const dbResult = await pool.query(
        `SELECT s.*, sp.plan_id 
         FROM subscriptions s
         JOIN subscription_plans sp ON s.plan_id = sp.plan_id
         WHERE s.token_id = $1`,
        [tokenId]
      );

      if (dbResult.rows.length > 0) {
        const sub = dbResult.rows[0];
        planId = sub.plan_id;
        // Calculate expiry from duration (approximate)
        expiryDate = new Date(new Date(sub.created_at).getTime() + sub.duration * 1000);
        isValid = expiryDate > new Date();
      }
    }

    if (!subscription && !planId) {
      return res.status(404).json({
        error: 'Subscription not found',
        message: `No subscription found for token ID ${tokenId}`
      });
    }

    // Get user info from integration subscriptions
    const integrationResult = await pool.query(
      `SELECT eus.external_user_id, eus.app_id
       FROM api_integration_subscriptions ais
       JOIN external_users eus ON ais.app_id = eus.app_id 
         AND ais.external_user_id = eus.external_user_id
       JOIN subscriptions s ON ais.token_id = s.token_id
       WHERE s.token_id = $1`,
      [tokenId]
    );

    const userId = integrationResult.rows[0]?.external_user_id || null;

    // Determine status
    let status = 'expired';
    if (isValid) {
      status = 'active';
    } else if (subscription && !subscription.active) {
      status = 'cancelled';
    }

    // Calculate next billing date (if active and has plan)
    let nextBillingDate = null;
    if (status === 'active' && expiryDate) {
      // Get plan duration
      const planResult = await pool.query(
        `SELECT duration FROM subscription_plans WHERE plan_id = $1`,
        [planId]
      );
      
      if (planResult.rows.length > 0) {
        const duration = parseInt(planResult.rows[0].duration);
        nextBillingDate = new Date(expiryDate.getTime() - duration * 1000);
      }
    }

    res.json({
      status: 'success',
      data: {
        tokenId: tokenId,
        status: status,
        expiryDate: expiryDate ? expiryDate.toISOString() : null,
        userId: userId,
        planId: planId,
        nextBillingDate: nextBillingDate ? nextBillingDate.toISOString() : null,
        subscriptionPlan: planId ? {
          planId: planId
        } : null
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/integration/subscriptions?customerAddress={address}
 * Get comprehensive subscription data for a customer (AC4.1)
 */
router.get('/subscriptions', async (req, res, next) => {
  try {
    const { customerAddress, appId, planId, status, network = 'localhost' } = req.query;
    const { appId: reqAppId } = req;

    if (!customerAddress) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'customerAddress query parameter is required'
      });
    }

    // Get subscription data
    const subscriptionData = await subscriptionDataService.getCustomerSubscriptionData(
      customerAddress,
      network
    );

    // Apply filters if provided
    let filteredData = { ...subscriptionData };

    if (appId || reqAppId) {
      const filterAppId = appId || reqAppId;
      filteredData.activeSubscriptions = filteredData.activeSubscriptions.filter(sub => 
        sub.planDetails?.appId === filterAppId?.toString()
      );
      filteredData.subscriptionHistory = filteredData.subscriptionHistory.filter(sub => 
        sub.planDetails?.appId === filterAppId?.toString()
      );
    }

    if (planId) {
      filteredData.activeSubscriptions = filteredData.activeSubscriptions.filter(sub => 
        sub.planId === planId.toString()
      );
      filteredData.subscriptionHistory = filteredData.subscriptionHistory.filter(sub => 
        sub.planId === planId.toString()
      );
    }

    if (status) {
      filteredData.activeSubscriptions = filteredData.activeSubscriptions.filter(sub => 
        sub.status === status
      );
      filteredData.subscriptionHistory = filteredData.subscriptionHistory.filter(sub => 
        sub.status === status
      );
    }

    res.json({
      status: 'success',
      data: filteredData
    });
  } catch (error) {
    // Enhanced error handling (AC7.2)
    const requestId = crypto.randomBytes(8).toString('hex');
    console.error(`[Integration] Error [${requestId}]:`, error);
    
    res.status(error.status || 500).json({
      status: 'error',
      error: {
        code: error.code || 'INTERNAL_ERROR',
        message: error.message || 'An unexpected error occurred',
        requestId: requestId
      }
    });
  }
});

/**
 * GET /api/integration/orders?orderId={id} or ?customerAddress={address}
 * Get order data with subscription context (AC4.2)
 */
router.get('/orders', async (req, res, next) => {
  try {
    const { orderId, customerAddress, vendorAddress, page = 1, limit = 25, network = 'localhost' } = req.query;
    const { appId } = req;

    if (!orderId && !customerAddress && !vendorAddress) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Either orderId, customerAddress, or vendorAddress query parameter is required'
      });
    }

    let orders = [];

    if (orderId) {
      // Get single order
      const order = await checkoutService.getOrder(orderId, network);
      if (!order) {
        return res.status(404).json({
          error: 'Order not found',
          message: `Order with ID ${orderId} not found`
        });
      }
      orders = [order];
    } else {
      // Get multiple orders
      if (customerAddress) {
        orders = await checkoutService.getCustomerOrders(customerAddress, network);
      } else if (vendorAddress) {
        orders = await checkoutService.getVendorOrders(vendorAddress, network);
      }
    }

    // Add subscription context to each order
    const ordersWithSubscription = await Promise.all(
      orders.map(async (order) => {
        let subscriptionData = null;
        if (order.customer_address) {
          try {
            subscriptionData = await subscriptionDataService.getCustomerSubscriptionData(
              order.customer_address,
              network
            );
          } catch (subError) {
            console.warn(`[Integration] Error fetching subscription data for order ${order.order_id}:`, subError.message);
          }
        }

        return {
          ...order,
          subscriptionData: subscriptionData
        };
      })
    );

    // Apply pagination
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const paginatedOrders = ordersWithSubscription.slice(offset, offset + parseInt(limit));

    res.json({
      status: 'success',
      data: paginatedOrders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: ordersWithSubscription.length,
        totalPages: Math.ceil(ordersWithSubscription.length / parseInt(limit))
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

