/**
 * Webhook Management API Routes
 * Provides CRUD operations for webhooks and delivery logs
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { Pool } = require('pg');
const webhookService = require('../services/webhookService');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Generate a secure webhook secret
 */
function generateWebhookSecret() {
  return `whsec_${crypto.randomBytes(32).toString('hex')}`;
}

/**
 * Validate webhook URL
 */
function isValidWebhookUrl(url) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Available webhook events
 */
const WEBHOOK_EVENTS = [
  'subscription.purchased',
  'subscription.expired',
  'subscription.cancelled',
  'subscription.renewed',
  'order.created',
  'payment.completed',
  'order.status_changed',
  'order.accepted',
  'order.delivered',
  'order.refunded',
  'order.cancelled',
];

/**
 * POST /api/webhooks
 * Register a new webhook endpoint
 */
router.post('/', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    const { url, events, description } = req.body;

    if (!apiKey) {
      return res.status(401).json({ error: 'API key is required' });
    }

    if (!url) {
      return res.status(400).json({ error: 'Webhook URL is required' });
    }

    if (!isValidWebhookUrl(url)) {
      return res.status(400).json({ error: 'Invalid webhook URL. Must be HTTP or HTTPS.' });
    }

    if (!events || !Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ 
        error: 'At least one event is required',
        availableEvents: WEBHOOK_EVENTS
      });
    }

    // Validate events
    const invalidEvents = events.filter(e => !WEBHOOK_EVENTS.includes(e));
    if (invalidEvents.length > 0) {
      return res.status(400).json({
        error: `Invalid events: ${invalidEvents.join(', ')}`,
        availableEvents: WEBHOOK_EVENTS
      });
    }

    // Get app_id from API key
    let appId;
    const appResult = await pool.query(
      `SELECT app_id FROM apps WHERE api_key = $1`,
      [apiKey]
    );

    if (appResult.rows.length > 0) {
      appId = appResult.rows[0].app_id;
    } else {
      // Try checkout_apps
      const checkoutResult = await pool.query(
        `SELECT id FROM checkout_apps WHERE api_key = $1 AND status = 'active'`,
        [apiKey]
      );
      if (checkoutResult.rows.length > 0) {
        appId = `checkout_${checkoutResult.rows[0].id}`;
      }
    }

    if (!appId) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    // Generate secret
    const secret = generateWebhookSecret();

    // Create webhook
    const result = await pool.query(
      `INSERT INTO webhooks (app_id, url, secret, events, description)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (app_id, url) DO UPDATE
       SET events = EXCLUDED.events,
           description = EXCLUDED.description,
           active = true,
           updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [appId, url, secret, JSON.stringify(events), description || null]
    );

    const webhook = result.rows[0];

    res.status(201).json({
      success: true,
      data: {
        id: webhook.id,
        url: webhook.url,
        secret: webhook.secret, // Only returned on creation
        events: webhook.events,
        description: webhook.description,
        active: webhook.active,
        createdAt: webhook.created_at
      },
      message: 'Webhook registered successfully. Keep the secret safe - it will not be shown again.'
    });

  } catch (error) {
    console.error('[Webhooks] Error registering webhook:', error);
    res.status(500).json({ error: 'Failed to register webhook', message: error.message });
  }
});

/**
 * GET /api/webhooks
 * List all webhooks for the authenticated app
 */
router.get('/', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) {
      return res.status(401).json({ error: 'API key is required' });
    }

    // Get app_id from API key
    let appId;
    const appResult = await pool.query(
      `SELECT app_id FROM apps WHERE api_key = $1`,
      [apiKey]
    );

    if (appResult.rows.length > 0) {
      appId = appResult.rows[0].app_id;
    } else {
      const checkoutResult = await pool.query(
        `SELECT id FROM checkout_apps WHERE api_key = $1 AND status = 'active'`,
        [apiKey]
      );
      if (checkoutResult.rows.length > 0) {
        appId = `checkout_${checkoutResult.rows[0].id}`;
      }
    }

    if (!appId) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    const result = await pool.query(
      `SELECT id, url, events, description, active, created_at, updated_at,
              last_triggered_at, success_count, failure_count
       FROM webhooks
       WHERE app_id = $1
       ORDER BY created_at DESC`,
      [appId]
    );

    res.json({
      success: true,
      data: result.rows.map(w => ({
        id: w.id,
        url: w.url,
        events: w.events,
        description: w.description,
        active: w.active,
        createdAt: w.created_at,
        updatedAt: w.updated_at,
        lastTriggeredAt: w.last_triggered_at,
        stats: {
          successCount: w.success_count,
          failureCount: w.failure_count
        }
      }))
    });

  } catch (error) {
    console.error('[Webhooks] Error listing webhooks:', error);
    res.status(500).json({ error: 'Failed to list webhooks', message: error.message });
  }
});

/**
 * GET /api/webhooks/:id
 * Get a specific webhook
 */
router.get('/:id', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    const { id } = req.params;

    if (!apiKey) {
      return res.status(401).json({ error: 'API key is required' });
    }

    // Get app_id from API key
    let appId;
    const appResult = await pool.query(
      `SELECT app_id FROM apps WHERE api_key = $1`,
      [apiKey]
    );

    if (appResult.rows.length > 0) {
      appId = appResult.rows[0].app_id;
    } else {
      const checkoutResult = await pool.query(
        `SELECT id FROM checkout_apps WHERE api_key = $1 AND status = 'active'`,
        [apiKey]
      );
      if (checkoutResult.rows.length > 0) {
        appId = `checkout_${checkoutResult.rows[0].id}`;
      }
    }

    if (!appId) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    const result = await pool.query(
      `SELECT * FROM webhooks WHERE id = $1 AND app_id = $2`,
      [id, appId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    const w = result.rows[0];

    res.json({
      success: true,
      data: {
        id: w.id,
        url: w.url,
        events: w.events,
        description: w.description,
        active: w.active,
        createdAt: w.created_at,
        updatedAt: w.updated_at,
        lastTriggeredAt: w.last_triggered_at,
        stats: {
          successCount: w.success_count,
          failureCount: w.failure_count
        }
      }
    });

  } catch (error) {
    console.error('[Webhooks] Error getting webhook:', error);
    res.status(500).json({ error: 'Failed to get webhook', message: error.message });
  }
});

/**
 * PUT /api/webhooks/:id
 * Update a webhook
 */
router.put('/:id', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    const { id } = req.params;
    const { url, events, description, active } = req.body;

    if (!apiKey) {
      return res.status(401).json({ error: 'API key is required' });
    }

    // Get app_id from API key
    let appId;
    const appResult = await pool.query(
      `SELECT app_id FROM apps WHERE api_key = $1`,
      [apiKey]
    );

    if (appResult.rows.length > 0) {
      appId = appResult.rows[0].app_id;
    } else {
      const checkoutResult = await pool.query(
        `SELECT id FROM checkout_apps WHERE api_key = $1 AND status = 'active'`,
        [apiKey]
      );
      if (checkoutResult.rows.length > 0) {
        appId = `checkout_${checkoutResult.rows[0].id}`;
      }
    }

    if (!appId) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    // Validate URL if provided
    if (url && !isValidWebhookUrl(url)) {
      return res.status(400).json({ error: 'Invalid webhook URL' });
    }

    // Validate events if provided
    if (events) {
      if (!Array.isArray(events) || events.length === 0) {
        return res.status(400).json({ error: 'Events must be a non-empty array' });
      }
      const invalidEvents = events.filter(e => !WEBHOOK_EVENTS.includes(e));
      if (invalidEvents.length > 0) {
        return res.status(400).json({
          error: `Invalid events: ${invalidEvents.join(', ')}`,
          availableEvents: WEBHOOK_EVENTS
        });
      }
    }

    // Build update query dynamically
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (url !== undefined) {
      updates.push(`url = $${paramIndex++}`);
      values.push(url);
    }
    if (events !== undefined) {
      updates.push(`events = $${paramIndex++}`);
      values.push(JSON.stringify(events));
    }
    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(description);
    }
    if (active !== undefined) {
      updates.push(`active = $${paramIndex++}`);
      values.push(active);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id, appId);

    const result = await pool.query(
      `UPDATE webhooks 
       SET ${updates.join(', ')}
       WHERE id = $${paramIndex++} AND app_id = $${paramIndex}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    const w = result.rows[0];

    res.json({
      success: true,
      data: {
        id: w.id,
        url: w.url,
        events: w.events,
        description: w.description,
        active: w.active,
        updatedAt: w.updated_at
      }
    });

  } catch (error) {
    console.error('[Webhooks] Error updating webhook:', error);
    res.status(500).json({ error: 'Failed to update webhook', message: error.message });
  }
});

/**
 * DELETE /api/webhooks/:id
 * Delete a webhook
 */
router.delete('/:id', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    const { id } = req.params;

    if (!apiKey) {
      return res.status(401).json({ error: 'API key is required' });
    }

    // Get app_id from API key
    let appId;
    const appResult = await pool.query(
      `SELECT app_id FROM apps WHERE api_key = $1`,
      [apiKey]
    );

    if (appResult.rows.length > 0) {
      appId = appResult.rows[0].app_id;
    } else {
      const checkoutResult = await pool.query(
        `SELECT id FROM checkout_apps WHERE api_key = $1 AND status = 'active'`,
        [apiKey]
      );
      if (checkoutResult.rows.length > 0) {
        appId = `checkout_${checkoutResult.rows[0].id}`;
      }
    }

    if (!appId) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    const result = await pool.query(
      `DELETE FROM webhooks WHERE id = $1 AND app_id = $2 RETURNING id`,
      [id, appId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    res.json({
      success: true,
      message: 'Webhook deleted successfully'
    });

  } catch (error) {
    console.error('[Webhooks] Error deleting webhook:', error);
    res.status(500).json({ error: 'Failed to delete webhook', message: error.message });
  }
});

/**
 * POST /api/webhooks/:id/test
 * Send a test webhook
 */
router.post('/:id/test', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    const { id } = req.params;

    if (!apiKey) {
      return res.status(401).json({ error: 'API key is required' });
    }

    // Get app_id from API key
    let appId;
    const appResult = await pool.query(
      `SELECT app_id FROM apps WHERE api_key = $1`,
      [apiKey]
    );

    if (appResult.rows.length > 0) {
      appId = appResult.rows[0].app_id;
    } else {
      const checkoutResult = await pool.query(
        `SELECT id FROM checkout_apps WHERE api_key = $1 AND status = 'active'`,
        [apiKey]
      );
      if (checkoutResult.rows.length > 0) {
        appId = `checkout_${checkoutResult.rows[0].id}`;
      }
    }

    if (!appId) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    // Get webhook
    const webhookResult = await pool.query(
      `SELECT * FROM webhooks WHERE id = $1 AND app_id = $2`,
      [id, appId]
    );

    if (webhookResult.rows.length === 0) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    const webhook = webhookResult.rows[0];

    // Create test payload
    const testPayload = {
      test: true,
      timestamp: new Date().toISOString(),
      message: 'This is a test webhook from Elite Pass',
      webhookId: webhook.id,
      events: webhook.events
    };

    // Send test webhook
    const axios = require('axios');
    const startTime = Date.now();

    // Generate signature
    const signature = webhookService.generateWebhookSignature(
      { event: 'test', timestamp: testPayload.timestamp, data: testPayload },
      webhook.secret
    );

    try {
      const response = await axios.post(webhook.url, {
        event: 'test',
        timestamp: testPayload.timestamp,
        data: testPayload
      }, {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'ElitePass-Webhook/1.0',
          'X-Webhook-Signature': signature,
          'X-ElitePass-Timestamp': testPayload.timestamp
        },
        timeout: 10000
      });

      const duration = Date.now() - startTime;

      // Log the test
      await pool.query(
        `INSERT INTO webhook_logs (webhook_id, event_type, payload, webhook_url, status, status_code, duration_ms, delivered_at)
         VALUES ($1, 'test', $2, $3, 'success', $4, $5, CURRENT_TIMESTAMP)`,
        [webhook.id, JSON.stringify(testPayload), webhook.url, response.status, duration]
      );

      res.json({
        success: true,
        data: {
          statusCode: response.status,
          duration: `${duration}ms`,
          response: response.data
        },
        message: 'Test webhook sent successfully'
      });

    } catch (error) {
      const duration = Date.now() - startTime;
      const statusCode = error.response?.status || 0;
      const errorMessage = error.message;

      // Log the failure
      await pool.query(
        `INSERT INTO webhook_logs (webhook_id, event_type, payload, webhook_url, status, status_code, error_message, duration_ms)
         VALUES ($1, 'test', $2, $3, 'failed', $4, $5, $6)`,
        [webhook.id, JSON.stringify(testPayload), webhook.url, statusCode, errorMessage, duration]
      );

      res.status(200).json({
        success: false,
        data: {
          statusCode,
          duration: `${duration}ms`,
          error: errorMessage
        },
        message: 'Test webhook failed to deliver'
      });
    }

  } catch (error) {
    console.error('[Webhooks] Error sending test webhook:', error);
    res.status(500).json({ error: 'Failed to send test webhook', message: error.message });
  }
});

/**
 * GET /api/webhooks/:id/logs
 * Get delivery logs for a webhook
 */
router.get('/:id/logs', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    const { id } = req.params;
    const { limit = 50, offset = 0, status } = req.query;

    if (!apiKey) {
      return res.status(401).json({ error: 'API key is required' });
    }

    // Get app_id from API key
    let appId;
    const appResult = await pool.query(
      `SELECT app_id FROM apps WHERE api_key = $1`,
      [apiKey]
    );

    if (appResult.rows.length > 0) {
      appId = appResult.rows[0].app_id;
    } else {
      const checkoutResult = await pool.query(
        `SELECT id FROM checkout_apps WHERE api_key = $1 AND status = 'active'`,
        [apiKey]
      );
      if (checkoutResult.rows.length > 0) {
        appId = `checkout_${checkoutResult.rows[0].id}`;
      }
    }

    if (!appId) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    // Verify webhook belongs to app
    const webhookResult = await pool.query(
      `SELECT id FROM webhooks WHERE id = $1 AND app_id = $2`,
      [id, appId]
    );

    if (webhookResult.rows.length === 0) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    // Build query
    let query = `
      SELECT id, event_type, status, status_code, error_message, 
             attempt_number, max_attempts, duration_ms, delivered_at, created_at
      FROM webhook_logs
      WHERE webhook_id = $1
    `;
    const params = [id];

    if (status) {
      query += ` AND status = $2`;
      params.push(status);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM webhook_logs WHERE webhook_id = $1 ${status ? 'AND status = $2' : ''}`,
      status ? [id, status] : [id]
    );

    res.json({
      success: true,
      data: result.rows.map(log => ({
        id: log.id,
        eventType: log.event_type,
        status: log.status,
        statusCode: log.status_code,
        errorMessage: log.error_message,
        attemptNumber: log.attempt_number,
        maxAttempts: log.max_attempts,
        duration: log.duration_ms ? `${log.duration_ms}ms` : null,
        deliveredAt: log.delivered_at,
        createdAt: log.created_at
      })),
      pagination: {
        total: parseInt(countResult.rows[0].count),
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: parseInt(offset) + result.rows.length < parseInt(countResult.rows[0].count)
      }
    });

  } catch (error) {
    console.error('[Webhooks] Error getting webhook logs:', error);
    res.status(500).json({ error: 'Failed to get webhook logs', message: error.message });
  }
});

/**
 * POST /api/webhooks/:id/rotate-secret
 * Rotate the webhook secret
 */
router.post('/:id/rotate-secret', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    const { id } = req.params;

    if (!apiKey) {
      return res.status(401).json({ error: 'API key is required' });
    }

    // Get app_id from API key
    let appId;
    const appResult = await pool.query(
      `SELECT app_id FROM apps WHERE api_key = $1`,
      [apiKey]
    );

    if (appResult.rows.length > 0) {
      appId = appResult.rows[0].app_id;
    } else {
      const checkoutResult = await pool.query(
        `SELECT id FROM checkout_apps WHERE api_key = $1 AND status = 'active'`,
        [apiKey]
      );
      if (checkoutResult.rows.length > 0) {
        appId = `checkout_${checkoutResult.rows[0].id}`;
      }
    }

    if (!appId) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    // Generate new secret
    const newSecret = generateWebhookSecret();

    const result = await pool.query(
      `UPDATE webhooks 
       SET secret = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND app_id = $3
       RETURNING id, secret`,
      [newSecret, id, appId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    res.json({
      success: true,
      data: {
        id: result.rows[0].id,
        secret: result.rows[0].secret
      },
      message: 'Webhook secret rotated successfully. Keep the new secret safe.'
    });

  } catch (error) {
    console.error('[Webhooks] Error rotating secret:', error);
    res.status(500).json({ error: 'Failed to rotate secret', message: error.message });
  }
});

/**
 * GET /api/webhooks/events
 * List available webhook events
 */
router.get('/events/list', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT event_name, description, category FROM webhook_event_types ORDER BY category, event_name`
    );

    const eventsByCategory = result.rows.reduce((acc, event) => {
      if (!acc[event.category]) {
        acc[event.category] = [];
      }
      acc[event.category].push({
        name: event.event_name,
        description: event.description
      });
      return acc;
    }, {});

    res.json({
      success: true,
      data: {
        events: WEBHOOK_EVENTS,
        eventsByCategory
      }
    });

  } catch (error) {
    // Fallback if table doesn't exist
    res.json({
      success: true,
      data: {
        events: WEBHOOK_EVENTS,
        eventsByCategory: {
          subscription: WEBHOOK_EVENTS.filter(e => e.startsWith('subscription.')),
          checkout: WEBHOOK_EVENTS.filter(e => e.startsWith('order.') || e.startsWith('payment.'))
        }
      }
    });
  }
});

module.exports = router;







