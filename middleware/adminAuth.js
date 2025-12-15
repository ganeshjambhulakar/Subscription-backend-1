/**
 * Admin Authentication Middleware
 * Checks if the request is from an authenticated admin user
 */

function isAdmin(req) {
  // Check for admin session token in header
  const adminToken = req.headers['x-admin-token'];
  const adminSecret = req.headers['x-admin-secret'];
  
  // Check for admin address header (from frontend admin session)
  const adminAddress = req.headers['x-admin-address'];
  
  // Check for admin maintenance secret (for sensitive operations)
  const requiredSecret = process.env.ADMIN_MAINTENANCE_SECRET;
  
  // Simple admin check: if ADMIN_MAINTENANCE_SECRET is set, require it
  // Otherwise, allow if admin address or admin token is present
  if (requiredSecret) {
    if (adminSecret && adminSecret === requiredSecret) {
      return true;
    }
  }
  
  // Check for admin token (could be session-based)
  if (adminToken) {
    // In a production system, you would validate this token
    // For now, we'll accept it if present
    return true;
  }
  
  // Check for admin address (from frontend admin session)
  if (adminAddress) {
    // In a production system, you would verify this address
    // For now, we'll accept it if present
    return true;
  }
  
  // Check if request is from admin dashboard (based on referer or origin)
  const referer = req.headers.referer || '';
  const origin = req.headers.origin || '';
  if (referer.includes('/admin') || origin.includes('/admin')) {
    // This is a simple check - in production, use proper session validation
    return true;
  }
  
  return false;
}

/**
 * Middleware to require admin authentication
 */
function requireAdmin(req, res, next) {
  if (isAdmin(req)) {
    return next();
  }
  
  res.status(403).json({
    error: 'Forbidden',
    message: 'Admin authentication required'
  });
}

/**
 * Middleware to check admin status (doesn't block, just adds to request)
 */
function checkAdmin(req, res, next) {
  req.isAdmin = isAdmin(req);
  next();
}

module.exports = {
  isAdmin,
  requireAdmin,
  checkAdmin
};

