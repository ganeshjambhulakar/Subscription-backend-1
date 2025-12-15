const apiKeyService = require('../services/apiKeyService');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * API Key Authentication Middleware
 * Validates Bearer token and attaches API key info to request
 * Supports both api_keys table and apps.api_key column
 */
async function apiKeyAuth(req, res, next) {
  try {
    // Extract API key from Authorization header or X-API-Key header
    let apiKey = null;
    
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      apiKey = authHeader.substring(7); // Remove 'Bearer ' prefix
    } else if (req.headers['x-api-key']) {
      apiKey = req.headers['x-api-key'];
    }
    
    if (!apiKey) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing or invalid Authorization header. Use: Authorization: Bearer <API_KEY> or X-API-Key header'
      });
    }

    // Verify API key - check both api_keys table and apps.api_key
    let keyData = await apiKeyService.verifyApiKey(apiKey);
    
    // If not found in api_keys table, check apps table's api_key column
    if (!keyData) {
      const appResult = await pool.query(
        `SELECT app_id, vendor_address, name, active
         FROM apps
         WHERE api_key = $1 AND active = true`,
        [apiKey]
      );
      
      if (appResult.rows.length > 0) {
        const app = appResult.rows[0];
        // Create a keyData-like object from app
        keyData = {
          id: null, // No api_keys table ID
          app_id: app.app_id,
          app_name: app.name,
          permission_level: 'read', // Default permission for app-level keys
          active: true
        };
      }
    }
    
    if (!keyData) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or revoked API key'
      });
    }

    // Check rate limit (only for api_keys table entries, skip for app-level keys)
    let rateLimitStatus = null;
    if (keyData.id) {
      rateLimitStatus = await apiKeyService.getRateLimitStatus(keyData.id);
      
      if (rateLimitStatus.requestCount >= rateLimitStatus.rateLimit) {
        res.set({
          'X-RateLimit-Limit': rateLimitStatus.rateLimit.toString(),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': rateLimitStatus.resetAt.toISOString()
        });
        
        return res.status(429).json({
          error: 'Rate limit exceeded',
          message: `Rate limit of ${rateLimitStatus.rateLimit} requests per minute exceeded`,
          retryAfter: Math.ceil((rateLimitStatus.resetAt - Date.now()) / 1000)
        });
      }
    } else {
      // For app-level keys, use default rate limit (60 req/min)
      rateLimitStatus = {
        rateLimit: 60,
        remaining: 60,
        resetAt: new Date(Date.now() + 60000)
      };
    }

    // Attach API key data to request
    req.apiKey = keyData;
    req.apiKeyId = keyData.id; // May be null for app-level keys
    req.appId = keyData.app_id;

    // Set rate limit headers
    if (rateLimitStatus) {
      res.set({
        'X-RateLimit-Limit': rateLimitStatus.rateLimit.toString(),
        'X-RateLimit-Remaining': rateLimitStatus.remaining.toString(),
        'X-RateLimit-Reset': rateLimitStatus.resetAt.toISOString()
      });
    }

    // Update last used timestamp (only for api_keys table entries)
    if (keyData.id) {
      apiKeyService.updateLastUsed(keyData.id).catch(console.error);
    }

    next();
  } catch (error) {
    console.error('[API Key Auth] Error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to authenticate API key'
    });
  }
}

/**
 * Permission check middleware
 * Requires specific permission level
 */
function requirePermission(requiredPermission) {
  return (req, res, next) => {
    if (!req.apiKey) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'API key authentication required'
      });
    }

    const userPermission = req.apiKey.permission_level;
    
    // read-write can do everything, read can only read
    if (requiredPermission === 'read-write' && userPermission !== 'read-write') {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'This endpoint requires read-write permission'
      });
    }

    next();
  };
}

/**
 * Logging middleware for API requests
 */
function logApiRequest(req, res, next) {
  const startTime = Date.now();
  const originalSend = res.send;

  res.send = function(data) {
    const responseTime = Date.now() - startTime;
    
    // Log activity asynchronously
    if (req.apiKeyId) {
      const logData = {
        endpoint: req.path,
        method: req.method,
        statusCode: res.statusCode,
        responseTimeMs: responseTime,
        ipAddress: req.ip || req.connection.remoteAddress,
        userAgent: req.headers['user-agent'],
        requestBody: req.method !== 'GET' ? req.body : null,
        responseBody: res.statusCode >= 400 ? data : null,
        errorMessage: res.statusCode >= 400 ? (typeof data === 'string' ? data : JSON.stringify(data)) : null
      };

      apiKeyService.logActivity(req.apiKeyId, logData).catch(console.error);
    }

    return originalSend.call(this, data);
  };

  next();
}

module.exports = {
  apiKeyAuth,
  requirePermission,
  logApiRequest
};


