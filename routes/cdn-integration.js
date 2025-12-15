const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { apiKeyAuth } = require('../middleware/apiKeyAuth');
const apiKeyService = require('../services/apiKeyService');
const checkoutService = require('../checkout/services/checkoutService');
const contractService = require('../services/contractService');
const { ethers } = require('ethers');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Public CORS middleware for endpoints that don't require domain validation
// (like validate-key which is used to validate the API key itself)
// Also handles null origin (file:// protocol) for local HTML file testing
const publicCors = (req, res, next) => {
  const origin = req.headers.origin;
  
  // Handle null origin (file:// protocol) - must use * and cannot use credentials
  if (!origin || origin === 'null') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Note: Cannot use credentials with wildcard origin
  } else {
    // For specific origins, echo back the origin and allow credentials
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
};

/**
 * POST /api/integration/validate-key
 * Validate API key and return app info (for CDN script)
 * Public endpoint - no authentication required (used to validate key itself)
 */
router.post('/validate-key', publicCors, async (req, res, next) => {
  try {
    const { apiKey } = req.body;

    if (!apiKey) {
      return res.status(400).json({
        status: 'error',
        message: 'API key is required'
      });
    }

    // Validate API key - check both api_keys table and apps.api_key
    let keyInfo = await apiKeyService.verifyApiKey(apiKey);
    let appId = null;
    
    // If not found in api_keys table, check apps table's api_key column
    if (!keyInfo) {
      const appResult = await pool.query(
        `SELECT app_id, vendor_address, name, active
         FROM apps
         WHERE api_key = $1 AND active = true`,
        [apiKey]
      );
      
      if (appResult.rows.length > 0) {
        appId = appResult.rows[0].app_id;
        // Use app's api_key as fallback
        keyInfo = {
          app_id: appResult.rows[0].app_id,
          app_name: appResult.rows[0].name
        };
      }
    } else {
      appId = keyInfo.app_id;
    }
    
    if (!keyInfo || !appId) {
      return res.status(401).json({
        status: 'error',
        message: 'Invalid Integration Key'
      });
    }

    // Get app info
    const appResult = await pool.query(
      `SELECT a.*, a.vendor_address as vendor_id
       FROM apps a
       WHERE a.app_id = $1 AND a.active = true`,
      [appId]
    );

    if (appResult.rows.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'App unavailable'
      });
    }

    const app = appResult.rows[0];

    res.json({
      status: 'success',
      data: {
        appId: app.app_id,
        appName: app.name,
        vendorId: app.vendor_address,
        vendorName: app.name, // Using app name as vendor name fallback
        isActive: app.active
      }
    });
  } catch (error) {
    console.error('[CDN Integration] Error validating key:', error);
    next(error);
  }
});

/**
 * GET /api/integration/subscription-ui
 * Get subscription plans for UI rendering (CDN script)
 */
router.get('/subscription-ui', apiKeyAuth, async (req, res, next) => {
  try {
    const { appId } = req;

    // Get app info
    const appResult = await pool.query(
      `SELECT * FROM apps WHERE app_id = $1 AND active = true`,
      [appId]
    );

    if (appResult.rows.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'App unavailable'
      });
    }

    // Get all active plans for this app
    const plansResult = await pool.query(
      `SELECT 
        sp.plan_id,
        sp.name,
        sp.description,
        sp.price,
        sp.duration,
        sp.max_subscriptions,
        sp.pause_enabled,
        sp.max_pause_attempts,
        sp.active as is_active
       FROM subscription_plans sp
       WHERE sp.app_id = $1 
         AND sp.active = true
       ORDER BY sp.price ASC`,
      [appId]
    );

    const plans = plansResult.rows.map(plan => ({
      planId: plan.plan_id,
      name: plan.name,
      description: plan.description || '',
      price: plan.price,
      duration: plan.duration,
      durationDays: Math.floor(plan.duration / (24 * 60 * 60)),
      maxSubscriptions: plan.max_subscriptions,
      pauseEnabled: plan.pause_enabled,
      maxPauseAttempts: plan.max_pause_attempts,
      features: [], // Features not stored in DB, can be added later
      isActive: plan.is_active
    }));

    res.json({
      status: 'success',
      data: {
        appId: appId,
        plans: plans
      }
    });
  } catch (error) {
    console.error('[CDN Integration] Error fetching subscription UI:', error);
    next(error);
  }
});

/**
 * POST /api/integration/checkout
 * Initiate subscription checkout (for CDN script)
 */
router.post('/checkout', apiKeyAuth, async (req, res, next) => {
  try {
    const { planId, walletAddress, paymentMethod = 'crypto', currency = 'ETH' } = req.body;
    const { appId } = req;

    if (!planId) {
      return res.status(400).json({
        status: 'error',
        message: 'planId is required'
      });
    }

    if (!walletAddress) {
      return res.status(400).json({
        status: 'error',
        message: 'walletAddress is required'
      });
    }

    // Validate plan exists and belongs to app
    const planResult = await pool.query(
      `SELECT * FROM subscription_plans 
       WHERE plan_id = $1 AND app_id = $2 AND is_active = true`,
      [planId, appId]
    );

    if (planResult.rows.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'Plan not found or inactive'
      });
    }

    const plan = planResult.rows[0];

    // Get app vendor info
    const appResult = await pool.query(
      `SELECT vendor_id, vendor_address FROM apps WHERE app_id = $1`,
      [appId]
    );

    if (appResult.rows.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'App not found'
      });
    }

    const app = appResult.rows[0];

    // Calculate amounts
    let cryptoAmount = plan.price;
    let inrAmount = null;

    if (paymentMethod === 'inr') {
      // Convert INR to crypto using existing service
      const priceConversion = require('../checkout/services/priceConversion');
      const conversion = await priceConversion.convertInrToCrypto(
        parseFloat(plan.price),
        currency
      );
      cryptoAmount = conversion.cryptoAmount;
      inrAmount = parseFloat(plan.price);
    }

    // Create checkout order
    const orderData = {
      vendorAddress: app.vendor_address,
      customerAddress: walletAddress,
      totalAmount: cryptoAmount,
      currency: currency,
      paymentMethod: paymentMethod,
      cryptoCoin: currency,
      network: 'localhost',
      metadata: {
        appId: appId,
        planId: planId,
        source: 'cdn_integration'
      }
    };

    const order = await checkoutService.createOrder(orderData);

    // Log analytics
    await pool.query(
      `INSERT INTO api_activity_logs 
       (api_key_id, app_id, event_type, metadata)
       VALUES ($1, $2, $3, $4)`,
      [
        req.apiKeyId,
        appId,
        'checkout_initiated',
        JSON.stringify({ planId, walletAddress, orderId: order.order_id })
      ]
    ).catch(console.error);

    res.json({
      status: 'success',
      data: {
        orderId: order.order_id,
        planId: planId,
        amount: cryptoAmount.toString(),
        currency: currency,
        paymentMethod: paymentMethod,
        inrAmount: inrAmount,
        network: 'localhost'
      }
    });
  } catch (error) {
    console.error('[CDN Integration] Error in checkout:', error);
    next(error);
  }
});

/**
 * POST /api/integration/analytics
 * Log analytics events from CDN script
 * Uses publicCors to allow file:// protocol (local HTML files)
 */
router.post('/analytics', publicCors, async (req, res, next) => {
  try {
    const { eventType, metadata = {}, apiKey } = req.body;
    
    if (!eventType) {
      return res.status(400).json({
        status: 'error',
        message: 'eventType is required'
      });
    }

    // API key is optional for analytics (can be in body or header)
    const apiKeyToUse = apiKey || req.headers['x-api-key'];
    let appId = null;
    let apiKeyId = null;
    
    // If API key is provided, validate it and get app info
    if (apiKeyToUse) {
      const keyInfo = await apiKeyService.verifyApiKey(apiKeyToUse);
      if (keyInfo) {
        appId = keyInfo.app_id;
        apiKeyId = keyInfo.id;
      }
    }

    // Log analytics event (only if API key was provided and valid)
    if (apiKeyId && appId) {
      await pool.query(
        `INSERT INTO api_activity_logs 
         (api_key_id, app_id, event_type, metadata)
         VALUES ($1, $2, $3, $4)`,
        [apiKeyId, appId, eventType, JSON.stringify(metadata)]
      ).catch(console.error);
    }

    res.json({
      status: 'success',
      message: 'Analytics logged'
    });
  } catch (error) {
    console.error('[CDN Integration] Error logging analytics:', error);
    next(error);
  }
});

module.exports = router;

