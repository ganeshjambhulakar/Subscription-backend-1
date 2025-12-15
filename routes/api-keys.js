const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { checkMaintenanceMode } = require('../middleware/maintenanceMode');
const apiKeyService = require('../services/apiKeyService');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Apply maintenance mode middleware to all API key routes
router.use(checkMaintenanceMode('api'));

/**
 * POST /api/api-keys
 * Create a new API key for an app
 */
router.post('/', async (req, res, next) => {
  try {
    const { appId, name, permissionLevel, webhookUrl } = req.body;

    if (!appId) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'appId is required'
      });
    }

    // Verify app exists
    const appResult = await pool.query(
      `SELECT * FROM apps WHERE app_id = $1`,
      [appId]
    );

    if (appResult.rows.length === 0) {
      return res.status(404).json({
        error: 'App not found',
        message: `App with ID ${appId} not found`
      });
    }

    const apiKey = await apiKeyService.createApiKey(appId, {
      name: name || 'Default API Key',
      permissionLevel: permissionLevel || 'read',
      webhookUrl: webhookUrl || null
    });

    res.status(201).json({
      status: 'success',
      message: 'API key created successfully. Save the apiSecret securely - it will not be shown again.',
      data: {
        id: apiKey.id,
        apiKey: apiKey.api_key,
        apiSecret: apiKey.apiSecret, // Only shown once
        name: apiKey.name,
        permissionLevel: apiKey.permission_level,
        webhookUrl: apiKey.webhook_url,
        createdAt: apiKey.created_at
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/api-keys
 * Get all API keys for an app
 */
router.get('/', async (req, res, next) => {
  try {
    const { appId } = req.query;

    if (!appId) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'appId query parameter is required'
      });
    }

    const apiKeys = await apiKeyService.getApiKeysByApp(appId);

    res.json({
      status: 'success',
      data: apiKeys
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/api-keys/:id
 * Revoke an API key
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const revoked = await apiKeyService.revokeApiKey(id);

    if (!revoked) {
      return res.status(404).json({
        error: 'API key not found',
        message: `API key with ID ${id} not found`
      });
    }

    res.json({
      status: 'success',
      message: 'API key revoked successfully',
      data: revoked
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/api-keys/:id/regenerate
 * Regenerate an API key
 */
router.post('/:id/regenerate', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, permissionLevel, webhookUrl } = req.body;

    // Get API key to find appId
    const keyResult = await pool.query(
      `SELECT app_id FROM api_keys WHERE id = $1`,
      [id]
    );

    if (keyResult.rows.length === 0) {
      return res.status(404).json({
        error: 'API key not found',
        message: `API key with ID ${id} not found`
      });
    }

    const appId = keyResult.rows[0].app_id;

    const newApiKey = await apiKeyService.regenerateApiKey(id, appId, {
      name: name,
      permissionLevel: permissionLevel,
      webhookUrl: webhookUrl
    });

    res.status(201).json({
      status: 'success',
      message: 'API key regenerated successfully. Save the apiSecret securely - it will not be shown again.',
      data: {
        id: newApiKey.id,
        apiKey: newApiKey.api_key,
        apiSecret: newApiKey.apiSecret,
        name: newApiKey.name,
        permissionLevel: newApiKey.permission_level,
        webhookUrl: newApiKey.webhook_url,
        createdAt: newApiKey.created_at
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/api-keys/:id/stats
 * Get API key usage statistics
 */
router.get('/:id/stats', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { startDate, endDate } = req.query;

    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // Default: 30 days ago
    const end = endDate ? new Date(endDate) : new Date();

    const stats = await apiKeyService.getUsageStats(id, start, end);

    res.json({
      status: 'success',
      data: {
        ...stats,
        period: {
          start: start.toISOString(),
          end: end.toISOString()
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;


