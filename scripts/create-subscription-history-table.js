const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function createSubscriptionHistoryTable() {
  try {
    console.log('Creating subscription_history table...');
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscription_history (
        id SERIAL PRIMARY KEY,
        token_id VARCHAR(255) NOT NULL,
        plan_id VARCHAR(255) NOT NULL,
        subscriber_address VARCHAR(255) NOT NULL,
        vendor_address VARCHAR(255) NOT NULL,
        event_type VARCHAR(50) NOT NULL,
        event_data JSONB,
        transaction_hash VARCHAR(255),
        block_number BIGINT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (token_id) REFERENCES subscriptions(token_id) ON DELETE CASCADE
      )
    `);
    
    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_subscription_history_token 
      ON subscription_history(token_id)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_subscription_history_vendor 
      ON subscription_history(vendor_address)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_subscription_history_subscriber 
      ON subscription_history(subscriber_address)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_subscription_history_event_type 
      ON subscription_history(event_type)
    `);
    
    console.log('✅ Subscription history table created successfully');
    process.exit(0);
  } catch (error) {
    console.error('Error creating subscription history table:', error);
    process.exit(1);
  }
}

createSubscriptionHistoryTable();

