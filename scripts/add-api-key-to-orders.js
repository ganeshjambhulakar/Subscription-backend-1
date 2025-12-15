/**
 * Add api_key_id column to checkout_orders table
 * This links orders to checkout apps for tracking
 */

const { Pool } = require('pg');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function addApiKeyToOrders() {
  try {
    console.log('📦 Adding api_key_id to checkout_orders table...');

    // Add api_key_id column if it doesn't exist
    await pool.query(`
      ALTER TABLE checkout_orders 
      ADD COLUMN IF NOT EXISTS api_key_id INTEGER;
    `);

    // Add foreign key constraint (only if checkout_apps table exists)
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'checkout_apps') THEN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint 
            WHERE conname = 'checkout_orders_api_key_id_fkey'
          ) THEN
            ALTER TABLE checkout_orders 
            ADD CONSTRAINT checkout_orders_api_key_id_fkey 
            FOREIGN KEY (api_key_id) 
            REFERENCES checkout_apps(id);
          END IF;
        END IF;
      END $$;
    `);

    // Create index
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_checkout_orders_api_key 
      ON checkout_orders(api_key_id);
    `);

    console.log('✅ Added api_key_id to checkout_orders table');
    console.log('✅ Foreign key constraint added');
    console.log('✅ Index created');
  } catch (error) {
    console.error('❌ Error adding api_key_id:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

// Run if called directly
if (require.main === module) {
  addApiKeyToOrders()
    .then(() => {
      console.log('✅ Migration completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Migration failed:', error);
      process.exit(1);
    });
}

module.exports = { addApiKeyToOrders };

