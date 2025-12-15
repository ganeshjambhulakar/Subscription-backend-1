const axios = require('axios');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Calculate next retry time with exponential backoff
 */
function calculateNextRetry(attemptNumber, baseDelaySeconds = 60) {
  const delay = baseDelaySeconds * Math.pow(2, attemptNumber - 1);
  return new Date(Date.now() + delay * 1000);
}

/**
 * Generate HMAC signature for webhook payload
 */
function generateWebhookSignature(payload, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(JSON.stringify(payload));
  return hmac.digest('hex');
}

/**
 * Send webhook event
 */
async function sendWebhook(apiKeyId, eventType, payload, webhookUrl = null, apiSecret = null) {
  // Get webhook URL and secret from API key if not provided
  if (!webhookUrl || !apiSecret) {
    // Try checkout_apps table first
    let keyResult = await pool.query(
      `SELECT webhook_url, api_secret_hash FROM checkout_apps WHERE id = $1 AND webhook_url IS NOT NULL`,
      [apiKeyId]
    );

    // Fallback to api_keys table
    if (keyResult.rows.length === 0) {
      keyResult = await pool.query(
        `SELECT webhook_url, api_secret FROM api_keys WHERE id = $1 AND webhook_url IS NOT NULL`,
        [apiKeyId]
      );
    }

    if (keyResult.rows.length === 0 || !keyResult.rows[0].webhook_url) {
      console.log(`[Webhook] No webhook URL configured for API key ${apiKeyId}`);
      return null;
    }

    if (!webhookUrl) {
      webhookUrl = keyResult.rows[0].webhook_url;
    }
    
    // Note: api_secret_hash is hashed, we need the actual secret
    // For checkout_apps, we'll need to pass the secret separately
    // For api_keys, we can use api_secret if available
    if (!apiSecret && keyResult.rows[0].api_secret) {
      apiSecret = keyResult.rows[0].api_secret;
    }
  }

  // Create webhook log entry with max_attempts = 5 (AC3.1)
  const logResult = await pool.query(
    `INSERT INTO webhook_logs 
     (api_key_id, event_type, payload, webhook_url, status, attempt_number, max_attempts)
     VALUES ($1, $2, $3, $4, 'pending', 1, 5)
     RETURNING *`,
    [apiKeyId, eventType, JSON.stringify(payload), webhookUrl]
  );

  const webhookLog = logResult.rows[0];

  // Prepare webhook payload
  const webhookPayload = {
    event: eventType,
    timestamp: new Date().toISOString(),
    data: payload
  };

  // Generate signature if secret is available
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'ElitePass-Webhook/1.0'
  };

  if (apiSecret) {
    const signature = generateWebhookSignature(webhookPayload, apiSecret);
    headers['X-Webhook-Signature'] = signature;
  }

  // Send webhook (AC8.1 - optimize for < 2s delivery)
  try {
    // Create reusable agents for better performance
    const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
    const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });
    
    const response = await axios.post(webhookUrl, webhookPayload, {
      timeout: 8000, // 8 second timeout (optimized for < 2s target)
      headers: headers,
      httpAgent: httpAgent,
      httpsAgent: httpsAgent
    });

    // Update log as success
    await pool.query(
      `UPDATE webhook_logs 
       SET status = 'success', 
           status_code = $1,
           response_body = $2,
           delivered_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [response.status, JSON.stringify(response.data), webhookLog.id]
    );

    console.log(`[Webhook] ✅ Successfully sent ${eventType} to ${webhookUrl}`);
    return { success: true, logId: webhookLog.id };

  } catch (error) {
    const statusCode = error.response?.status || 0;
    const errorMessage = error.message || 'Unknown error';
    const nextRetry = calculateNextRetry(webhookLog.attempt_number);

    // Update log as failed
    await pool.query(
      `UPDATE webhook_logs 
       SET status = 'failed',
           status_code = $1,
           error_message = $2,
           next_retry_at = $3
       WHERE id = $4`,
      [statusCode, errorMessage, nextRetry, webhookLog.id]
    );

    console.error(`[Webhook] ❌ Failed to send ${eventType} to ${webhookUrl}:`, errorMessage);

    // Schedule retry if under max attempts
    if (webhookLog.attempt_number < webhookLog.max_attempts) {
      console.log(`[Webhook] ⏳ Scheduling retry ${webhookLog.attempt_number + 1}/${webhookLog.max_attempts} for ${nextRetry.toISOString()}`);
    }

    return { success: false, logId: webhookLog.id, error: errorMessage };
  }
}

/**
 * Retry failed webhooks
 */
async function retryFailedWebhooks() {
  const now = new Date();
  
  // Get pending/failed webhooks that are due for retry
  const result = await pool.query(
    `SELECT * FROM webhook_logs 
     WHERE status IN ('pending', 'failed')
       AND attempt_number < max_attempts
       AND (next_retry_at IS NULL OR next_retry_at <= $1)
     ORDER BY created_at ASC
     LIMIT 50`,
    [now]
  );

  for (const webhook of result.rows) {
    const attemptNumber = webhook.attempt_number + 1;
    
    // Update attempt number
    await pool.query(
      `UPDATE webhook_logs 
       SET attempt_number = $1, status = 'pending'
       WHERE id = $2`,
      [attemptNumber, webhook.id]
    );

    // Get API secret for signature if available
    let apiSecret = null;
    try {
      const keyResult = await pool.query(
        `SELECT api_secret FROM api_keys WHERE id = $1`,
        [webhook.api_key_id]
      );
      if (keyResult.rows.length > 0 && keyResult.rows[0].api_secret) {
        apiSecret = keyResult.rows[0].api_secret;
      }
    } catch (e) {
      // Ignore
    }

    // Prepare webhook payload
    const webhookPayload = {
      event: webhook.event_type,
      timestamp: new Date().toISOString(),
      data: JSON.parse(webhook.payload)
    };

    // Generate signature if secret available
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'ElitePass-Webhook/1.0'
    };

    if (apiSecret) {
      const signature = generateWebhookSignature(webhookPayload, apiSecret);
      headers['X-Webhook-Signature'] = signature;
    }

    // Retry sending
    try {
      const response = await axios.post(webhook.webhook_url, webhookPayload, {
        timeout: 10000,
        headers: headers
      });

      // Success
      await pool.query(
        `UPDATE webhook_logs 
         SET status = 'success',
             status_code = $1,
             response_body = $2,
             delivered_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [response.status, JSON.stringify(response.data), webhook.id]
      );

      console.log(`[Webhook] ✅ Retry successful for webhook ${webhook.id} (attempt ${attemptNumber})`);

    } catch (error) {
      const statusCode = error.response?.status || 0;
      const errorMessage = error.message || 'Unknown error';
      const nextRetry = calculateNextRetry(attemptNumber);

      // Update as failed, schedule next retry if under max
      if (attemptNumber < webhook.max_attempts) {
        await pool.query(
          `UPDATE webhook_logs 
           SET status = 'failed',
               status_code = $1,
               error_message = $2,
               next_retry_at = $3
           WHERE id = $4`,
          [statusCode, errorMessage, nextRetry, webhook.id]
        );
      } else {
        // Max attempts reached - mark as permanently failed (AC7.1)
        await pool.query(
          `UPDATE webhook_logs 
           SET status = 'failed',
               status_code = $1,
               error_message = $2
           WHERE id = $3`,
          [statusCode, `Max attempts (${webhook.max_attempts}) reached: ${errorMessage}`, webhook.id]
        );
        console.log(`[Webhook] ❌ Max attempts reached for webhook ${webhook.id} - permanently failed`);
        
        // TODO: Optionally notify vendor via email if configured (AC7.1)
        // This would require email service integration
      }
    }
  }

  return result.rows.length;
}

/**
 * Trigger webhook events
 */
async function triggerWebhook(apiKeyId, eventType, payload, webhookUrl = null, apiSecret = null) {
  return await sendWebhook(apiKeyId, eventType, payload, webhookUrl, apiSecret);
}

/**
 * Get API key ID from API key string (for checkout_apps or api_keys)
 */
async function getApiKeyIdFromKey(apiKey) {
  // Try checkout_apps first
  let result = await pool.query(
    `SELECT id, api_secret_hash FROM checkout_apps WHERE api_key = $1 AND status = 'active'`,
    [apiKey]
  );

  if (result.rows.length > 0) {
    return {
      id: result.rows[0].id,
      type: 'checkout_apps',
      apiSecretHash: result.rows[0].api_secret_hash
    };
  }

  // Fallback to api_keys
  result = await pool.query(
    `SELECT id, api_secret FROM api_keys WHERE api_key = $1 AND active = true`,
    [apiKey]
  );

  if (result.rows.length > 0) {
    return {
      id: result.rows[0].id,
      type: 'api_keys',
      apiSecret: result.rows[0].api_secret
    };
  }

  return null;
}

/**
 * Get webhook logs for an API key
 */
async function getWebhookLogs(apiKeyId, limit = 100) {
  const result = await pool.query(
    `SELECT * FROM webhook_logs 
     WHERE api_key_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [apiKeyId, limit]
  );

  return result.rows;
}

/**
 * Start webhook retry worker (runs every minute)
 */
function startWebhookWorker() {
  console.log('[Webhook] Starting webhook retry worker...');
  
  // Run immediately
  retryFailedWebhooks().catch(console.error);

  // Then run every minute
  setInterval(() => {
    retryFailedWebhooks().catch(console.error);
  }, 60000); // 60 seconds
}

module.exports = {
  sendWebhook,
  retryFailedWebhooks,
  triggerWebhook,
  getWebhookLogs,
  startWebhookWorker,
  generateWebhookSignature,
  getApiKeyIdFromKey
};


