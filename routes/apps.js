const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const crypto = require('crypto');
const { checkMaintenanceMode } = require('../middleware/maintenanceMode');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Generate API key from transaction hash
 * API key is the transaction hash of app creation
 */
function generateApiKey(transactionHash) {
  // API key is the transaction hash itself
  return transactionHash ? transactionHash.toString() : null;
}

/**
 * Generate a unique app ID
 */
function generateAppId() {
  // Generate a unique app ID: app_ prefix + timestamp + random
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString('hex');
  return `app_${timestamp}_${random}`;
}

/**
 * POST /api/apps
 * Create a new app for a vendor (syncs with blockchain)
 */
router.post('/', async (req, res, next) => {
  try {
    const { vendorAddress, name, description, appId, transactionHash, blockNumber, useExistingAppId, existingAppId, network } = req.body;
    
    if (!vendorAddress || !name) {
      return res.status(400).json({ error: 'Vendor address and app name are required' });
    }
    
    // API key is the transaction hash of app creation
    // If transactionHash is provided, use it directly as the API key
    // If transaction hash conversion failed, use existing appId as fallback
    let apiKey = null;
    let blockchainAppId = appId; // Store blockchain integer ID separately
    let finalAppId = null; // Will be generated formatted app ID
    
    // Check if we should use existing appId (fallback case)
    if (useExistingAppId && existingAppId) {
      // Transaction hash conversion failed, use existing appId
      console.log('Using existing appId as fallback:', existingAppId);
      blockchainAppId = existingAppId.toString();
      
      // Try to find existing app to get its API key (check both app_id and blockchain_app_id)
      try {
        const existingAppResult = await pool.query(
          'SELECT api_key, app_id, blockchain_app_id FROM apps WHERE (app_id = $1 OR blockchain_app_id = $1) AND vendor_address = $2',
          [blockchainAppId, vendorAddress.toLowerCase()]
        );
        
        if (existingAppResult.rows.length > 0) {
          // Use existing app's formatted app_id and API key
          finalAppId = existingAppResult.rows[0].app_id;
          apiKey = existingAppResult.rows[0].api_key || finalAppId;
          console.log('Using existing app:', finalAppId, 'API key:', apiKey);
        } else {
          // No existing app found, generate formatted app ID
          finalAppId = generateAppId();
          apiKey = transactionHash || blockchainAppId;
        }
      } catch (e) {
        console.warn('Error fetching existing app:', e);
        // Generate formatted app ID
        finalAppId = generateAppId();
        apiKey = transactionHash || blockchainAppId;
      }
    } else if (transactionHash && blockchainAppId) {
      // Normal case: Use transaction hash as the API key
      apiKey = transactionHash;
      
      // Generate formatted app ID for database storage
      if (!finalAppId) {
        finalAppId = generateAppId();
      }
    } else if (blockchainAppId) {
      // If no transactionHash but blockchainAppId is provided
      finalAppId = generateAppId();
      apiKey = generateApiKey(blockchainAppId);
    } else {
      // Try to find existing app with same name and vendor
      try {
        const existingAppResult = await pool.query(
          'SELECT app_id, api_key, blockchain_app_id FROM apps WHERE name = $1 AND vendor_address = $2 ORDER BY created_at DESC LIMIT 1',
          [name, vendorAddress.toLowerCase()]
        );
        
        if (existingAppResult.rows.length > 0) {
          // Use existing app's data
          finalAppId = existingAppResult.rows[0].app_id;
          apiKey = existingAppResult.rows[0].api_key || finalAppId;
          blockchainAppId = existingAppResult.rows[0].blockchain_app_id || blockchainAppId;
          console.log('Found existing app, using appId:', finalAppId, 'API key:', apiKey);
        } else {
          return res.status(400).json({ 
            error: 'Transaction hash and app ID are required. App must be created on blockchain first.' 
          });
        }
      } catch (e) {
        console.error('Error checking for existing app:', e);
        return res.status(400).json({ 
          error: 'Transaction hash and app ID are required. App must be created on blockchain first.' 
        });
      }
    }
    
    // Ensure we have formatted app ID
    if (!finalAppId) {
      finalAppId = generateAppId();
    }
    
    // Ensure we have blockchain app ID
    if (!blockchainAppId && appId) {
      blockchainAppId = appId;
    }
    
    if (!apiKey) {
      // Fallback: use appId as API key
      apiKey = finalAppId;
    }
    
    if (!apiKey) {
      return res.status(400).json({ 
        error: 'Invalid appId. Cannot generate API key.' 
      });
    }
    
    // Get vendor's network preference if not provided
    let appNetwork = network;
    if (!appNetwork) {
      try {
        const vendorProfile = await pool.query(
          'SELECT network FROM vendor_profiles WHERE vendor_address = $1',
          [vendorAddress.toLowerCase()]
        );
        if (vendorProfile.rows.length > 0 && vendorProfile.rows[0].network) {
          appNetwork = vendorProfile.rows[0].network;
        } else {
          appNetwork = 'localhost'; // Default
        }
      } catch (e) {
        appNetwork = 'localhost'; // Default on error
      }
    }

    // Upsert vendor profile (ensure vendor exists in vendor_profiles table)
    try {
      await pool.query(
        `INSERT INTO vendor_profiles (vendor_address, network, updated_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (vendor_address) DO UPDATE SET
           network = EXCLUDED.network,
           updated_at = CURRENT_TIMESTAMP`,
        [vendorAddress.toLowerCase(), appNetwork]
      );
    } catch (vendorProfileError) {
      // Log error but don't fail app creation if vendor profile upsert fails
      console.warn('Warning: Failed to upsert vendor profile:', vendorProfileError.message);
    }

    // Add blockchain_app_id column if it doesn't exist (for storing blockchain integer ID)
    try {
      await pool.query(`
        ALTER TABLE apps 
        ADD COLUMN IF NOT EXISTS blockchain_app_id VARCHAR(255)
      `);
    } catch (e) {
      // Column might already exist, ignore error
    }

    const result = await pool.query(
      `INSERT INTO apps (app_id, vendor_address, name, description, api_key, network, blockchain_app_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (app_id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         api_key = EXCLUDED.api_key,
         network = EXCLUDED.network,
         blockchain_app_id = EXCLUDED.blockchain_app_id,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [finalAppId, vendorAddress.toLowerCase(), name, description || null, apiKey, appNetwork, blockchainAppId || null]
    );
    
    res.status(201).json({
      success: true,
      app: result.rows[0],
      message: 'App created successfully'
    });
  } catch (error) {
    console.error('Error creating app:', error);
    next(error);
  }
});

/**
 * GET /api/apps/vendor/:vendorAddress
 * Get all apps for a vendor (includes both subscription apps and checkout apps)
 */
router.get('/vendor/:vendorAddress', async (req, res, next) => {
  try {
    const { vendorAddress } = req.params;
    const { network } = req.query; // Get network filter from query params
    
    // Query subscription apps from apps table
    let subscriptionQuery = `
      SELECT 
        a.*,
        'subscription' as app_type,
        COUNT(DISTINCT sp.plan_id) as total_plans,
        COUNT(DISTINCT CASE WHEN sp.active = true THEN sp.plan_id END) as active_plans,
        COUNT(DISTINCT s.token_id) as total_subscriptions
       FROM apps a
       LEFT JOIN subscription_plans sp ON a.app_id = sp.app_id
       LEFT JOIN subscriptions s ON sp.plan_id = s.plan_id
       WHERE a.vendor_address = $1
    `;
    const params = [vendorAddress.toLowerCase()];
    
    // Filter by network if provided
    if (network) {
      subscriptionQuery += ` AND (a.network = $2 OR a.network IS NULL)`;
      params.push(network);
    }
    
    subscriptionQuery += ` GROUP BY a.id, a.app_id, a.vendor_address, a.name, a.description, a.api_key, a.active, a.network, a.created_at, a.updated_at`;
    
    // Query checkout apps from checkout_apps table
    let checkoutQuery = `
      SELECT 
        ca.app_id,
        ca.vendor_address,
        ca.app_name as name,
        ca.description,
        ca.api_key,
        ca.status as active,
        'localhost' as network,
        ca.created_at,
        ca.updated_at,
        'checkout' as app_type,
        0 as total_plans,
        0 as active_plans,
        0 as total_subscriptions
       FROM checkout_apps ca
       WHERE ca.vendor_address = $1 AND ca.status = 'active'
    `;
    const checkoutParams = [vendorAddress.toLowerCase()];
    
    // Filter checkout apps by network if provided
    if (network) {
      checkoutQuery += ` AND ($2 = 'localhost' OR $2 IS NULL)`;
      checkoutParams.push(network);
    }
    
    // Execute both queries
    const [subscriptionResult, checkoutResult] = await Promise.all([
      pool.query(subscriptionQuery, params),
      pool.query(checkoutQuery, checkoutParams)
    ]);
    
    // Combine results
    const allApps = [
      ...subscriptionResult.rows,
      ...checkoutResult.rows
    ];
    
    // Sort by created_at DESC
    allApps.sort((a, b) => {
      const dateA = new Date(a.created_at);
      const dateB = new Date(b.created_at);
      return dateB - dateA;
    });
    
    res.json(allApps);
  } catch (error) {
    console.error('Error fetching apps:', error);
    next(error);
  }
});

/**
 * GET /api/apps/:appId
 * Get a specific app by ID
 */
router.get('/:appId', async (req, res, next) => {
  try {
    const { appId } = req.params;
    
    const result = await pool.query(
      `SELECT 
        a.*,
        COUNT(DISTINCT sp.plan_id) as total_plans,
        COUNT(DISTINCT CASE WHEN sp.active = true THEN sp.plan_id END) as active_plans,
        COUNT(DISTINCT s.token_id) as total_subscriptions
       FROM apps a
       LEFT JOIN subscription_plans sp ON a.app_id = sp.app_id
       LEFT JOIN subscriptions s ON sp.plan_id = s.plan_id
       WHERE a.app_id = $1
       GROUP BY a.id, a.app_id, a.vendor_address, a.name, a.description, a.api_key, a.active, a.created_at, a.updated_at`,
      [appId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'App not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching app:', error);
    next(error);
  }
});

/**
 * PUT /api/apps/:appId
 * Update an app
 */
router.put('/:appId', async (req, res, next) => {
  try {
    const { appId } = req.params;
    const { name, description, active } = req.body;
    
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(description);
    }
    if (active !== undefined) {
      updates.push(`active = $${paramCount++}`);
      values.push(active);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    
    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(appId);
    
    const result = await pool.query(
      `UPDATE apps 
       SET ${updates.join(', ')}
       WHERE app_id = $${paramCount}
       RETURNING *`,
      values
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'App not found' });
    }
    
    res.json({
      success: true,
      app: result.rows[0],
      message: 'App updated successfully'
    });
  } catch (error) {
    console.error('Error updating app:', error);
    next(error);
  }
});

/**
 * POST /api/apps/:appId/regenerate-key
 * Regenerate API key for an app (not applicable - API key is the appId)
 */
router.post('/:appId/regenerate-key', async (req, res, next) => {
  try {
    const { appId } = req.params;
    
    // API key is the appId itself, so we just ensure it's synced
    const apiKey = appId; // API key is the blockchain appId
    
    const result = await pool.query(
      `UPDATE apps 
       SET api_key = $1, updated_at = CURRENT_TIMESTAMP
       WHERE app_id = $2
       RETURNING *`,
      [apiKey, appId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'App not found' });
    }
    
    res.json({
      success: true,
      app: result.rows[0],
      message: 'API key synced with blockchain appId'
    });
  } catch (error) {
    console.error('Error syncing API key:', error);
    next(error);
  }
});

/**
 * DELETE /api/apps/:appId
 * Delete an app (soft delete by setting active to false)
 */
router.delete('/:appId', async (req, res, next) => {
  try {
    const { appId } = req.params;
    
    // Check if app has active plans
    const plansResult = await pool.query(
      `SELECT COUNT(*) as count FROM subscription_plans WHERE app_id = $1 AND active = true`,
      [appId]
    );
    
    if (parseInt(plansResult.rows[0].count) > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete app with active plans. Please deactivate all plans first.' 
      });
    }
    
    const result = await pool.query(
      `UPDATE apps 
       SET active = false, updated_at = CURRENT_TIMESTAMP
       WHERE app_id = $1
       RETURNING *`,
      [appId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'App not found' });
    }
    
    res.json({
      success: true,
      message: 'App deactivated successfully'
    });
  } catch (error) {
    console.error('Error deleting app:', error);
    next(error);
  }
});

/**
 * GET /api/apps/verify/:apiKey
 * Verify an API key (for external integrations)
 * API key is the blockchain appId, so we verify it exists on blockchain
 */
router.get('/verify/:apiKey', async (req, res, next) => {
  try {
    const { apiKey } = req.params;
    
    // API key is the appId, so check both database and blockchain
    const result = await pool.query(
      `SELECT app_id, vendor_address, name, active 
       FROM apps 
       WHERE app_id = $1 AND active = true`,
      [apiKey]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ 
        valid: false,
        error: 'Invalid or inactive API key' 
      });
    }
    
    // Verify app exists on blockchain
    try {
      const contractService = require('../services/contractService');
      const contract = await contractService.getContract();
      const app = await contract.getApp(apiKey);
      
      if (!app || !app.active) {
        return res.status(401).json({ 
          valid: false,
          error: 'App is not active on blockchain' 
        });
      }
      
      res.json({
        valid: true,
        app: {
          ...result.rows[0],
          blockchain: {
            name: app.name,
            description: app.description,
            active: app.active,
            vendor: app.vendor
          }
        }
      });
    } catch (blockchainError) {
      // If blockchain verification fails, still return database result
      // but mark it as potentially invalid
      console.warn('Blockchain verification failed:', blockchainError);
      res.json({
        valid: true,
        app: result.rows[0],
        warning: 'Could not verify on blockchain'
      });
    }
  } catch (error) {
    console.error('Error verifying API key:', error);
    next(error);
  }
});

module.exports = router;

