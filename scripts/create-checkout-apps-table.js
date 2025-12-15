/**
 * Create checkout_apps table for checkout app management
 * This table stores checkout apps with their API keys
 */

const { Pool } = require('pg');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function createCheckoutAppsTable() {
  try {
    console.log('📦 Creating checkout_apps table...');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS checkout_apps (
        id SERIAL PRIMARY KEY,
        app_id VARCHAR(255) UNIQUE NOT NULL,
        vendor_address VARCHAR(255) NOT NULL,
        api_key VARCHAR(255) UNIQUE NOT NULL,
        api_secret_hash VARCHAR(255) NOT NULL,
        app_name VARCHAR(255),
        description TEXT,
        webhook_url TEXT,
        status VARCHAR(50) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_used_at TIMESTAMP
      );
    `);

    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_checkout_apps_vendor 
        ON checkout_apps(vendor_address);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_checkout_apps_api_key 
        ON checkout_apps(api_key);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_checkout_apps_status 
        ON checkout_apps(status);
    `);

    console.log('✅ Checkout apps table created successfully');
    console.log('✅ Indexes created successfully');
  } catch (error) {
    console.error('❌ Error creating checkout apps table:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

// Run if called directly
if (require.main === module) {
  createCheckoutAppsTable()
    .then(() => {
      console.log('✅ Migration completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Migration failed:', error);
      process.exit(1);
    });
}

module.exports = { createCheckoutAppsTable };

