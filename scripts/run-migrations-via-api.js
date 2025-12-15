/**
 * Run migrations via the server's database connection
 * This script creates the necessary tables by making API calls
 * or by using the same connection method as the server
 */

const { Pool } = require('pg');
const path = require('path');
const dotenv = require('dotenv');

// Load .env from backend directory
dotenv.config({ path: path.join(__dirname, '../.env') });

// Also try loading from root
dotenv.config({ path: path.join(__dirname, '../../.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function runMigrations() {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    console.log('📦 Running migrations...\n');
    
    // 1. Create checkout_apps table
    console.log('1. Creating checkout_apps table...');
    await client.query(`
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
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_checkout_apps_vendor 
        ON checkout_apps(vendor_address);
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_checkout_apps_api_key 
        ON checkout_apps(api_key);
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_checkout_apps_status 
        ON checkout_apps(status);
    `);
    
    console.log('   ✅ checkout_apps table created\n');
    
    // 2. Add api_key_id to checkout_orders
    console.log('2. Adding api_key_id to checkout_orders...');
    await client.query(`
      ALTER TABLE checkout_orders 
      ADD COLUMN IF NOT EXISTS api_key_id INTEGER;
    `);
    
    // Check if checkout_apps exists before adding foreign key
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'checkout_apps'
      )
    `);
    
    if (tableCheck.rows[0].exists) {
      const constraintCheck = await client.query(`
        SELECT EXISTS (
          SELECT 1 FROM pg_constraint 
          WHERE conname = 'checkout_orders_api_key_id_fkey'
        )
      `);
      
      if (!constraintCheck.rows[0].exists) {
        await client.query(`
          ALTER TABLE checkout_orders 
          ADD CONSTRAINT checkout_orders_api_key_id_fkey 
          FOREIGN KEY (api_key_id) 
          REFERENCES checkout_apps(id);
        `);
      }
    }
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_checkout_orders_api_key 
      ON checkout_orders(api_key_id);
    `);
    
    console.log('   ✅ api_key_id column added\n');
    
    await client.query('COMMIT');
    console.log('✅ All migrations completed successfully!');
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run migrations
runMigrations()
  .then(() => {
    console.log('\n✅ Migration process completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Migration process failed:', error);
    process.exit(1);
  });








