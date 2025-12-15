/**
 * Migration endpoints
 * Run database migrations via API (uses server's database connection)
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * POST /api/migrations/run
 * Run all pending migrations
 */
router.post('/run', async (req, res, next) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const results = [];
    
    // 1. Create checkout_apps table
    console.log('[Migration] Creating checkout_apps table...');
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
    
    results.push('✅ checkout_apps table created');
    
    // 2. Add api_key_id to checkout_orders
    console.log('[Migration] Adding api_key_id to checkout_orders...');
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
    
    results.push('✅ api_key_id column added to checkout_orders');
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      message: 'Migrations completed successfully',
      results: results
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Migration] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  } finally {
    client.release();
  }
});

module.exports = router;








