const { Pool } = require('pg');
const dotenv = require('dotenv');
const crypto = require('crypto');

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function createAppsTable() {
  try {
    console.log('Creating apps table...');
    
    // Create apps table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS apps (
        id SERIAL PRIMARY KEY,
        app_id VARCHAR(255) UNIQUE NOT NULL,
        vendor_address VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        api_key VARCHAR(255) UNIQUE NOT NULL,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Add app_id column to subscription_plans if it doesn't exist
    try {
      await pool.query(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS app_id VARCHAR(255)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_plans_app ON subscription_plans(app_id)`);
    } catch (e) {
      console.warn('Could not add app_id column or index:', e.message);
    }
    
    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_apps_vendor 
      ON apps(vendor_address)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_apps_api_key 
      ON apps(api_key)
    `);
    
    console.log('✅ Apps table created successfully');
    process.exit(0);
  } catch (error) {
    console.error('Error creating apps table:', error);
    process.exit(1);
  }
}

createAppsTable();

