const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const domainVerificationService = require('../services/domainVerificationService');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * POST /api/vendor/verify-domain
 * Create domain verification request
 * Requires vendor authentication (via vendor_address or API key)
 */
router.post('/verify-domain', async (req, res, next) => {
  try {
    const { apiKey, domain, method = 'meta_tag' } = req.body;
    
    if (!apiKey || !domain) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'apiKey and domain are required'
      });
    }
    
    // Validate method
    if (!['meta_tag', 'dns', 'file'].includes(method)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'method must be one of: meta_tag, dns, file'
      });
    }
    
    // Get app by API key
    const appResult = await pool.query(
      `SELECT app_id, vendor_address FROM apps WHERE api_key = $1`,
      [apiKey]
    );
    
    if (appResult.rows.length === 0) {
      return res.status(404).json({
        error: 'App not found',
        message: 'Invalid API key'
      });
    }
    
    const app = appResult.rows[0];
    
    // Create verification request
    const verification = await domainVerificationService.createVerificationRequest(
      app.app_id,
      domain,
      method
    );
    
    res.status(201).json({
      status: 'success',
      message: 'Domain verification request created',
      data: verification
    });
  } catch (error) {
    console.error('[DomainVerification] Error:', error);
    next(error);
  }
});

/**
 * POST /api/vendor/verify-domain/confirm
 * Confirm domain verification (called after meta tag/DNS/file verification)
 */
router.post('/verify-domain/confirm', async (req, res, next) => {
  try {
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'token is required'
      });
    }
    
    const result = await domainVerificationService.verifyDomain(token);
    
    res.json({
      status: 'success',
      message: 'Domain verified successfully',
      data: result
    });
  } catch (error) {
    console.error('[DomainVerification] Error:', error);
    
    if (error.message.includes('Invalid or expired')) {
      return res.status(400).json({
        error: 'Verification failed',
        message: error.message
      });
    }
    
    next(error);
  }
});

/**
 * GET /api/vendor/verify-domain/status
 * Get verification status for a domain
 */
router.get('/verify-domain/status', async (req, res, next) => {
  try {
    const { apiKey, domain } = req.query;
    
    if (!apiKey || !domain) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'apiKey and domain query parameters are required'
      });
    }
    
    // Get app by API key
    const appResult = await pool.query(
      `SELECT app_id FROM apps WHERE api_key = $1`,
      [apiKey]
    );
    
    if (appResult.rows.length === 0) {
      return res.status(404).json({
        error: 'App not found',
        message: 'Invalid API key'
      });
    }
    
    const app = appResult.rows[0];
    const status = await domainVerificationService.getVerificationStatus(app.app_id, domain);
    
    res.json({
      status: 'success',
      data: status
    });
  } catch (error) {
    console.error('[DomainVerification] Error:', error);
    next(error);
  }
});

module.exports = router;

