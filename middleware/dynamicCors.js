const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Extract domain from origin URL
 * @param {string} origin - Origin header value (e.g., "https://shopabc.com")
 * @returns {string|null} - Domain (e.g., "shopabc.com") or null
 */
function extractDomain(origin) {
  if (!origin) return null;
  
  try {
    const url = new URL(origin);
    return url.hostname;
  } catch (e) {
    // If origin is not a valid URL, try to extract domain directly
    return origin.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  }
}

/**
 * Check if domain matches any allowed domain (supports wildcards)
 * @param {string} domain - Domain to check
 * @param {string[]} allowedDomains - Array of allowed domains
 * @returns {boolean}
 */
function isDomainAllowed(domain, allowedDomains) {
  if (!domain || !allowedDomains || allowedDomains.length === 0) {
    return false;
  }
  
  const normalizedDomain = domain.toLowerCase();
  
  return allowedDomains.some(allowed => {
    const normalizedAllowed = allowed.toLowerCase();
    
    // Exact match
    if (normalizedDomain === normalizedAllowed) {
      return true;
    }
    
    // Wildcard subdomain match (e.g., *.example.com matches sub.example.com)
    if (normalizedAllowed.startsWith('*.')) {
      const baseDomain = normalizedAllowed.substring(2);
      return normalizedDomain === baseDomain || normalizedDomain.endsWith('.' + baseDomain);
    }
    
    // Subdomain match (e.g., example.com matches sub.example.com)
    if (normalizedDomain.endsWith('.' + normalizedAllowed)) {
      return true;
    }
    
    return false;
  });
}

/**
 * Log failed CORS attempt
 */
async function logFailedAttempt(apiKey, origin, endpoint, method, ip, userAgent, reason) {
  try {
    await pool.query(
      `INSERT INTO cors_failed_attempts 
       (api_key, origin, endpoint, method, ip_address, user_agent, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [apiKey || null, origin || null, endpoint || null, method || null, ip || null, userAgent || null, reason]
    );
  } catch (error) {
    console.error('[DynamicCORS] Error logging failed attempt:', error);
  }
}

/**
 * Dynamic CORS middleware
 * Validates Origin header against allowedDomains and API key
 */
async function dynamicCors(req, res, next) {
  // Handle OPTIONS preflight requests
  if (req.method === 'OPTIONS') {
    // Customer endpoints don't require API key
    if (req.path.match(/^\/api\/checkout\/customer\/[^\/]+\/orders$/)) {
      const origin = req.headers.origin;
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Key');
      if (origin) {
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
      return res.status(200).end();
    }
    
    const origin = req.headers.origin;
    const apiKey = req.headers['x-api-key'];
    
    // Handle null origin (file:// protocol) - allow in development
    if (origin === 'null' || (!origin && process.env.NODE_ENV !== 'production')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Key');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      return res.status(200).end();
    }
    
    if (origin && apiKey) {
      try {
        // Fetch app by API key
        const appResult = await pool.query(
          `SELECT app_id, allowed_domains, verified_domains, active 
           FROM apps 
           WHERE api_key = $1`,
          [apiKey]
        );
        
        if (appResult.rows.length > 0) {
          const app = appResult.rows[0];
          
          if (!app.active) {
            await logFailedAttempt(apiKey, origin, req.path, req.method, req.ip, req.get('user-agent'), 'app_inactive');
            return res.status(403).json({
              error: 'Unauthorized',
              message: 'App is inactive'
            });
          }
          
          const allowedDomains = app.allowed_domains || [];
          const domain = extractDomain(origin);
          
          if (isDomainAllowed(domain, allowedDomains)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Key');
            res.setHeader('Access-Control-Allow-Credentials', 'true');
            res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
            return res.status(200).end();
          }
        }
      } catch (error) {
        console.error('[DynamicCORS] Error in OPTIONS:', error);
      }
    }
    
    // Default OPTIONS response
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Key');
    return res.status(200).end();
  }
  
  // Skip validation for public endpoints (like validate-key, analytics)
  if (req.path === '/api/integration/validate-key' || 
      req.path.endsWith('/validate-key') ||
      req.path === '/api/integration/analytics' ||
      req.path.endsWith('/analytics')) {
    return next();
  }
  
  // Skip validation for customer-facing endpoints (customers don't have API keys)
  // Customer endpoints: /api/checkout/customer/*/orders
  if (req.path.match(/^\/api\/checkout\/customer\/[^\/]+\/orders$/)) {
    // Set permissive CORS headers for customer endpoints
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Key');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
      // No origin - allow from anywhere in development
      if (process.env.NODE_ENV !== 'production') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Key');
      }
    }
    return next();
  }
  
  // For non-OPTIONS requests, validate Origin and API key
  const origin = req.headers.origin;
  const apiKey = req.headers['x-api-key'];
  
  // Handle null origin (file:// protocol) - allow in development
  if (origin === 'null' || (!origin && process.env.NODE_ENV !== 'production')) {
    // In development, allow null origin for local file access
    // Set permissive CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Key');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    // If no API key provided with null origin, still allow (for development)
    if (!apiKey) {
      return next();
    }
  }
  
  // Allow requests without Origin header ONLY for admin/internal routes
  // (e.g., Postman, curl, server-to-server)
  // Also allow app creation route (POST /api/apps) - vendors create apps before they have API keys
  const isInternalRoute =
    req.path.startsWith('/api/admin') ||
    (req.path.startsWith('/api/vendor') && req.method === 'GET') ||
    (req.path === '/api/apps' && req.method === 'POST');
  
  if (isInternalRoute && !origin && origin !== 'null') {
    // Internal route without Origin - allow but don't set CORS headers
    return next();
  }
  
  // For app creation (POST /api/apps), allow without API key since vendor doesn't have one yet
  if (req.path === '/api/apps' && req.method === 'POST') {
    // Set permissive CORS headers for app creation
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Key');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Key');
    }
    return next();
  }
  
  // For checkout app creation (POST /api/checkout/apps), allow without API key since vendor doesn't have one yet
  // Note: When middleware is mounted at /api/checkout, req.path will be /apps, not /api/checkout/apps
  if ((req.path === '/apps' || req.path === '/api/checkout/apps') && req.method === 'POST') {
    // Set permissive CORS headers for checkout app creation
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Key');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Key');
    }
    return next();
  }
  
  // External API routes require both Origin and API key
  if (!origin || !apiKey) {
    const reason = !origin ? 'missing_origin' : 'missing_api_key';
    await logFailedAttempt(apiKey || null, origin || null, req.path, req.method, req.ip, req.get('user-agent'), reason);
    
    return res.status(403).json({
      error: 'Unauthorized',
      message: 'Unauthorized domain or invalid API key',
      details: !origin ? 'Origin header is required' : 'X-API-Key header is required'
    });
  }
  
  try {
    // Fetch app by API key
    const appResult = await pool.query(
      `SELECT app_id, vendor_address, allowed_domains, verified_domains, active 
       FROM apps 
       WHERE api_key = $1`,
      [apiKey]
    );
    
    if (appResult.rows.length === 0) {
      await logFailedAttempt(apiKey, origin, req.path, req.method, req.ip, req.get('user-agent'), 'invalid_api_key');
      return res.status(403).json({
        error: 'Unauthorized',
        message: 'Unauthorized domain or invalid API key'
      });
    }
    
    const app = appResult.rows[0];
    
    // Check if app is active
    if (!app.active) {
      await logFailedAttempt(apiKey, origin, req.path, req.method, req.ip, req.get('user-agent'), 'app_inactive');
      return res.status(403).json({
        error: 'Unauthorized',
        message: 'App is inactive'
      });
    }
    
    // Extract and validate domain
    const domain = extractDomain(origin);
    const allowedDomains = app.allowed_domains || [];
    
    // In development, allow localhost and 127.0.0.1 even if not in allowed domains
    const isDevelopment = process.env.NODE_ENV !== 'production';
    const isLocalhost = domain === 'localhost' || domain === '127.0.0.1' || domain === '::1';
    
    if (!isDomainAllowed(domain, allowedDomains) && !(isDevelopment && isLocalhost)) {
      await logFailedAttempt(apiKey, origin, req.path, req.method, req.ip, req.get('user-agent'), 'domain_not_allowed');
      return res.status(403).json({
        error: 'Unauthorized',
        message: 'Unauthorized domain or invalid API key',
        details: `Domain ${domain} is not in the allowed domains list`
      });
    }
    
    // Validation passed - set CORS headers dynamically
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Key');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    // Attach app info to request for use in route handlers
    req.appInfo = {
      appId: app.app_id,
      vendorAddress: app.vendor_address,
      allowedDomains: allowedDomains,
      verifiedDomains: app.verified_domains || []
    };
    
    next();
  } catch (error) {
    console.error('[DynamicCORS] Error validating CORS:', error);
    await logFailedAttempt(apiKey || null, origin || null, req.path, req.method, req.ip, req.get('user-agent'), 'validation_error');
    
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Error validating request'
    });
  }
}

module.exports = dynamicCors;

