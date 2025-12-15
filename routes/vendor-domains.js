const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * PUT /api/vendor/apps/:appId/domains
 * Update allowed domains for an app
 * Requires vendor authentication (vendor_address must match app owner)
 */
router.put('/apps/:appId/domains', async (req, res, next) => {
  try {
    const { appId } = req.params;
    const { vendorAddress, allowedDomains } = req.body;
    
    if (!vendorAddress) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'vendorAddress is required'
      });
    }
    
    if (!Array.isArray(allowedDomains)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'allowedDomains must be an array'
      });
    }
    
    // Validate domain format
    // Allow localhost and IP addresses for development
    const domainRegex = /^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}$|^\*\.([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}$|^localhost(:\d+)?$|^127\.0\.0\.1(:\d+)?$|^\[::1\](:\d+)?$/i;
    for (const domain of allowedDomains) {
      if (typeof domain !== 'string' || !domainRegex.test(domain)) {
        return res.status(400).json({
          error: 'Validation error',
          message: `Invalid domain format: ${domain}. Domains must be valid (e.g., example.com, *.example.com, localhost, 127.0.0.1)`
        });
      }
    }
    
    // Get app and verify ownership
    const appResult = await pool.query(
      `SELECT app_id, vendor_address, allowed_domains, verified_domains 
       FROM apps 
       WHERE app_id = $1`,
      [appId]
    );
    
    if (appResult.rows.length === 0) {
      return res.status(404).json({
        error: 'App not found',
        message: `App with ID ${appId} not found`
      });
    }
    
    const app = appResult.rows[0];
    
    // Verify vendor ownership
    if (app.vendor_address.toLowerCase() !== vendorAddress.toLowerCase()) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You do not have permission to update this app'
      });
    }
    
    // Filter to only include verified domains (optional - can be disabled)
    const verifiedDomains = app.verified_domains || [];
    const requireVerification = req.body.requireVerification !== false; // Default true
    
    let finalAllowedDomains = allowedDomains;
    
    if (requireVerification) {
      // Only allow verified domains
      finalAllowedDomains = allowedDomains.filter(domain => {
        const normalizedDomain = domain.toLowerCase().replace(/^\*\./, '');
        return verifiedDomains.some(verified => {
          const normalizedVerified = verified.toLowerCase();
          return normalizedDomain === normalizedVerified || normalizedDomain.endsWith('.' + normalizedVerified);
        });
      });
      
      if (finalAllowedDomains.length < allowedDomains.length) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'Some domains are not verified. Please verify domains before adding them to allowed list.',
          unverifiedDomains: allowedDomains.filter(d => !finalAllowedDomains.includes(d))
        });
      }
    }
    
    // Update allowed domains
    const updateResult = await pool.query(
      `UPDATE apps 
       SET allowed_domains = $1, updated_at = NOW()
       WHERE app_id = $2
       RETURNING app_id, allowed_domains, verified_domains`,
      [JSON.stringify(finalAllowedDomains), appId]
    );
    
    res.json({
      status: 'success',
      message: 'Allowed domains updated successfully',
      data: {
        appId: updateResult.rows[0].app_id,
        allowedDomains: updateResult.rows[0].allowed_domains,
        verifiedDomains: updateResult.rows[0].verified_domains
      }
    });
  } catch (error) {
    console.error('[VendorDomains] Error:', error);
    next(error);
  }
});

/**
 * GET /api/vendor/apps/:appId/domains
 * Get allowed and verified domains for an app
 */
router.get('/apps/:appId/domains', async (req, res, next) => {
  try {
    const { appId } = req.params;
    const { vendorAddress } = req.query;
    
    // Get app
    const appResult = await pool.query(
      `SELECT app_id, vendor_address, allowed_domains, verified_domains 
       FROM apps 
       WHERE app_id = $1`,
      [appId]
    );
    
    if (appResult.rows.length === 0) {
      return res.status(404).json({
        error: 'App not found',
        message: `App with ID ${appId} not found`
      });
    }
    
    const app = appResult.rows[0];
    
    // Verify vendor ownership if vendorAddress provided
    if (vendorAddress && app.vendor_address.toLowerCase() !== vendorAddress.toLowerCase()) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You do not have permission to view this app'
      });
    }
    
    res.json({
      status: 'success',
      data: {
        appId: app.app_id,
        allowedDomains: app.allowed_domains || [],
        verifiedDomains: app.verified_domains || []
      }
    });
  } catch (error) {
    console.error('[VendorDomains] Error:', error);
    next(error);
  }
});

module.exports = router;

