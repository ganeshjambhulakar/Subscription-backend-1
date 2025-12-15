const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function addCorsDomainColumns() {
  try {
    console.log('📦 Adding CORS domain columns to apps table...');
    
    // Add allowedDomains column (JSONB array)
    await pool.query(`
      ALTER TABLE apps 
      ADD COLUMN IF NOT EXISTS allowed_domains JSONB DEFAULT '[]'::jsonb
    `);
    console.log('  ✅ Added allowed_domains column');
    
    // Add verifiedDomains column (JSONB array)
    await pool.query(`
      ALTER TABLE apps 
      ADD COLUMN IF NOT EXISTS verified_domains JSONB DEFAULT '[]'::jsonb
    `);
    console.log('  ✅ Added verified_domains column');
    
    // Add domain_verification_tokens table for domain verification
    await pool.query(`
      CREATE TABLE IF NOT EXISTS domain_verification_tokens (
        id SERIAL PRIMARY KEY,
        app_id VARCHAR(255) NOT NULL,
        domain VARCHAR(255) NOT NULL,
        token VARCHAR(255) UNIQUE NOT NULL,
        verification_method VARCHAR(20) DEFAULT 'meta_tag' CHECK (verification_method IN ('meta_tag', 'dns', 'file')),
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'expired')),
        expires_at TIMESTAMP NOT NULL,
        verified_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (app_id) REFERENCES apps(app_id) ON DELETE CASCADE
      )
    `);
    console.log('  ✅ Created domain_verification_tokens table');
    
    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_domain_tokens_app_id 
      ON domain_verification_tokens(app_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_domain_tokens_token 
      ON domain_verification_tokens(token)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_domain_tokens_status 
      ON domain_verification_tokens(status)
    `);
    console.log('  ✅ Created indexes');
    
    // Add cors_failed_attempts table for logging failed CORS attempts
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cors_failed_attempts (
        id SERIAL PRIMARY KEY,
        api_key VARCHAR(255),
        origin VARCHAR(255),
        endpoint VARCHAR(255),
        method VARCHAR(10),
        ip_address VARCHAR(45),
        user_agent TEXT,
        reason VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('  ✅ Created cors_failed_attempts table');
    
    // Create indexes for cors_failed_attempts
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_cors_failed_api_key 
      ON cors_failed_attempts(api_key)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_cors_failed_created_at 
      ON cors_failed_attempts(created_at)
    `);
    console.log('  ✅ Created indexes for cors_failed_attempts');
    
    console.log('\n✅ All CORS domain columns and tables created successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error adding CORS domain columns:', error);
    process.exit(1);
  }
}

addCorsDomainColumns();

