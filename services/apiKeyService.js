const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Generate a new API key and secret
 */
function generateApiKey() {
  const apiKey = `ep_${crypto.randomBytes(24).toString('hex')}`;
  const apiSecret = crypto.randomBytes(32).toString('hex');
  return { apiKey, apiSecret };
}

/**
 * Hash API secret for storage
 */
function hashSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

/**
 * Create a new API key for an app
 */
async function createApiKey(appId, options = {}) {
  const {
    name = 'Default API Key',
    permissionLevel = 'read',
    webhookUrl = null
  } = options;

  const { apiKey, apiSecret } = generateApiKey();
  const hashedSecret = hashSecret(apiSecret);

  const result = await pool.query(
    `INSERT INTO api_keys (app_id, api_key, api_secret, name, permission_level, webhook_url)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [appId, apiKey, hashedSecret, name, permissionLevel, webhookUrl]
  );

  // Return the API key with the unhashed secret (only shown once)
  return {
    ...result.rows[0],
    apiSecret // Include unhashed secret for initial response only
  };
}

/**
 * Verify API key and return key details
 */
async function verifyApiKey(apiKey) {
  const result = await pool.query(
    `SELECT ak.*, a.vendor_address, a.name as app_name
     FROM api_keys ak
     JOIN apps a ON ak.app_id = a.app_id
     WHERE ak.api_key = $1 AND ak.active = true AND ak.revoked_at IS NULL`,
    [apiKey]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

/**
 * Get all API keys for an app
 */
async function getApiKeysByApp(appId) {
  const result = await pool.query(
    `SELECT id, api_key, name, permission_level, active, created_at, last_used_at, revoked_at
     FROM api_keys
     WHERE app_id = $1
     ORDER BY created_at DESC`,
    [appId]
  );

  return result.rows;
}

/**
 * Revoke an API key
 */
async function revokeApiKey(apiKeyId) {
  const result = await pool.query(
    `UPDATE api_keys
     SET active = false, revoked_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING *`,
    [apiKeyId]
  );

  return result.rows[0];
}

/**
 * Regenerate API key (revoke old, create new)
 */
async function regenerateApiKey(apiKeyId, appId, options = {}) {
  // Revoke old key
  await revokeApiKey(apiKeyId);

  // Create new key
  return await createApiKey(appId, options);
}

/**
 * Update API key last used timestamp
 */
async function updateLastUsed(apiKeyId) {
  await pool.query(
    `UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [apiKeyId]
  );
}

/**
 * Log API activity
 */
async function logActivity(apiKeyId, logData) {
  const {
    endpoint,
    method,
    statusCode,
    responseTimeMs,
    ipAddress,
    userAgent,
    requestBody,
    responseBody,
    errorMessage
  } = logData;

  await pool.query(
    `INSERT INTO api_activity_logs 
     (api_key_id, endpoint, method, status_code, response_time_ms, ip_address, user_agent, request_body, response_body, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [apiKeyId, endpoint, method, statusCode, responseTimeMs, ipAddress, userAgent, requestBody, responseBody, errorMessage]
  );
}

/**
 * Get API key usage statistics
 */
async function getUsageStats(apiKeyId, startDate, endDate) {
  const result = await pool.query(
    `SELECT 
       COUNT(*) as total_requests,
       COUNT(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 END) as success_count,
       COUNT(CASE WHEN status_code >= 400 THEN 1 END) as error_count,
       AVG(response_time_ms) as avg_response_time,
       MAX(response_time_ms) as max_response_time
     FROM api_activity_logs
     WHERE api_key_id = $1 
       AND created_at >= $2 
       AND created_at <= $3`,
    [apiKeyId, startDate, endDate]
  );

  return result.rows[0];
}

/**
 * Get rate limit status for an API key
 */
async function getRateLimitStatus(apiKeyId, windowMinutes = 1) {
  const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);

  const result = await pool.query(
    `SELECT COUNT(*) as request_count
     FROM api_activity_logs
     WHERE api_key_id = $1 
       AND created_at >= $2`,
    [apiKeyId, windowStart]
  );

  const requestCount = parseInt(result.rows[0].request_count);
  const apiKey = await pool.query(
    `SELECT rate_limit FROM api_keys WHERE id = $1`,
    [apiKeyId]
  );

  const rateLimit = apiKey.rows[0]?.rate_limit || 60;

  return {
    requestCount,
    rateLimit,
    remaining: Math.max(0, rateLimit - requestCount),
    resetAt: new Date(Date.now() + windowMinutes * 60 * 1000)
  };
}

module.exports = {
  createApiKey,
  verifyApiKey,
  getApiKeysByApp,
  revokeApiKey,
  regenerateApiKey,
  updateLastUsed,
  logActivity,
  getUsageStats,
  getRateLimitStatus
};


