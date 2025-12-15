const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Generate verification token
 */
function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Create domain verification request
 * @param {string} appId - App ID
 * @param {string} domain - Domain to verify
 * @param {string} method - Verification method ('meta_tag', 'dns', 'file')
 * @returns {Promise<Object>} - Verification token and details
 */
async function createVerificationRequest(appId, domain, method = 'meta_tag') {
  try {
    // Check if app exists
    const appResult = await pool.query(
      `SELECT app_id, vendor_address FROM apps WHERE app_id = $1`,
      [appId]
    );
    
    if (appResult.rows.length === 0) {
      throw new Error('App not found');
    }
    
    // Generate token
    const token = generateVerificationToken();
    
    // Set expiration (7 days from now)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    
    // Check if there's an existing pending verification
    const existingResult = await pool.query(
      `SELECT * FROM domain_verification_tokens 
       WHERE app_id = $1 AND domain = $2 AND status = 'pending' AND expires_at > NOW()`,
      [appId, domain]
    );
    
    if (existingResult.rows.length > 0) {
      // Return existing token
      return {
        token: existingResult.rows[0].token,
        method: existingResult.rows[0].verification_method,
        expiresAt: existingResult.rows[0].expires_at,
        verificationUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/verify-domain?token=${existingResult.rows[0].token}`,
        metaTag: `<meta name="elitepass-verification" content="${existingResult.rows[0].token}">`
      };
    }
    
    // Create new verification request
    const result = await pool.query(
      `INSERT INTO domain_verification_tokens 
       (app_id, domain, token, verification_method, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [appId, domain, token, method, expiresAt]
    );
    
    const verification = result.rows[0];
    
    return {
      token: verification.token,
      method: verification.verification_method,
      expiresAt: verification.expires_at,
      verificationUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/verify-domain?token=${verification.token}`,
      metaTag: `<meta name="elitepass-verification" content="${verification.token}">`,
      dnsRecord: method === 'dns' ? `TXT elitepass-verification=${token}` : null,
      fileContent: method === 'file' ? token : null,
      filePath: method === 'file' ? '/.well-known/elitepass-verification.txt' : null
    };
  } catch (error) {
    console.error('[DomainVerification] Error creating verification request:', error);
    throw error;
  }
}

/**
 * Verify domain using token
 * @param {string} token - Verification token
 * @returns {Promise<Object>} - Verification result
 */
async function verifyDomain(token) {
  try {
    // Find verification request
    const result = await pool.query(
      `SELECT * FROM domain_verification_tokens 
       WHERE token = $1 AND status = 'pending' AND expires_at > NOW()`,
      [token]
    );
    
    if (result.rows.length === 0) {
      throw new Error('Invalid or expired verification token');
    }
    
    const verification = result.rows[0];
    
    // Update verification status
    await pool.query(
      `UPDATE domain_verification_tokens 
       SET status = 'verified', verified_at = NOW()
       WHERE id = $1`,
      [verification.id]
    );
    
    // Add domain to app's verified domains
    const appResult = await pool.query(
      `SELECT verified_domains FROM apps WHERE app_id = $1`,
      [verification.app_id]
    );
    
    if (appResult.rows.length > 0) {
      const verifiedDomains = appResult.rows[0].verified_domains || [];
      
      if (!verifiedDomains.includes(verification.domain)) {
        verifiedDomains.push(verification.domain);
        
        await pool.query(
          `UPDATE apps 
           SET verified_domains = $1, updated_at = NOW()
           WHERE app_id = $2`,
          [JSON.stringify(verifiedDomains), verification.app_id]
        );
      }
    }
    
    return {
      success: true,
      domain: verification.domain,
      appId: verification.app_id
    };
  } catch (error) {
    console.error('[DomainVerification] Error verifying domain:', error);
    throw error;
  }
}

/**
 * Get verification status for a domain
 * @param {string} appId - App ID
 * @param {string} domain - Domain
 * @returns {Promise<Object>} - Verification status
 */
async function getVerificationStatus(appId, domain) {
  try {
    const result = await pool.query(
      `SELECT * FROM domain_verification_tokens 
       WHERE app_id = $1 AND domain = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [appId, domain]
    );
    
    if (result.rows.length === 0) {
      return {
        verified: false,
        status: 'not_requested'
      };
    }
    
    const verification = result.rows[0];
    
    return {
      verified: verification.status === 'verified',
      status: verification.status,
      method: verification.verification_method,
      expiresAt: verification.expires_at,
      verifiedAt: verification.verified_at
    };
  } catch (error) {
    console.error('[DomainVerification] Error getting verification status:', error);
    throw error;
  }
}

module.exports = {
  createVerificationRequest,
  verifyDomain,
  getVerificationStatus
};

