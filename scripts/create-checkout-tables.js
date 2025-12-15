const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function createCheckoutTables() {
  try {
    console.log('Creating checkout tables...');
    
    // Create checkout_orders table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS checkout_orders (
        id SERIAL PRIMARY KEY,
        order_id VARCHAR(255) UNIQUE NOT NULL,
        vendor_address VARCHAR(255) NOT NULL,
        customer_address VARCHAR(255),
        total_amount NUMERIC(20, 8) NOT NULL,
        currency VARCHAR(10) DEFAULT 'ETH',
        status VARCHAR(50) DEFAULT 'pending',
        network VARCHAR(50) DEFAULT 'localhost',
        transaction_hash VARCHAR(255),
        metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP
      )
    `);
    
    // Create checkout_order_items table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS checkout_order_items (
        id SERIAL PRIMARY KEY,
        order_id VARCHAR(255) NOT NULL,
        product_id VARCHAR(255),
        product_name VARCHAR(255) NOT NULL,
        product_description TEXT,
        quantity INTEGER DEFAULT 1,
        unit_price NUMERIC(20, 8) NOT NULL,
        total_price NUMERIC(20, 8) NOT NULL,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES checkout_orders(order_id) ON DELETE CASCADE
      )
    `);
    
    // Create vendor_api_keys table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vendor_api_keys (
        id SERIAL PRIMARY KEY,
        vendor_address VARCHAR(255) NOT NULL,
        api_key VARCHAR(255) UNIQUE NOT NULL,
        api_secret VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        active BOOLEAN DEFAULT true,
        webhook_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_used_at TIMESTAMP
      )
    `);
    
    // Create vendor_webhooks table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vendor_webhooks (
        id SERIAL PRIMARY KEY,
        vendor_address VARCHAR(255) NOT NULL,
        api_key_id INTEGER,
        order_id VARCHAR(255) NOT NULL,
        event_type VARCHAR(50) NOT NULL,
        payload JSONB NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        last_attempt_at TIMESTAMP,
        response_status INTEGER,
        response_body TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES checkout_orders(order_id) ON DELETE CASCADE
      )
    `);
    
    // Create checkout_transactions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS checkout_transactions (
        id SERIAL PRIMARY KEY,
        order_id VARCHAR(255) NOT NULL,
        transaction_hash VARCHAR(255) UNIQUE NOT NULL,
        from_address VARCHAR(255) NOT NULL,
        to_address VARCHAR(255) NOT NULL,
        amount NUMERIC(20, 8) NOT NULL,
        gas_used BIGINT,
        gas_price NUMERIC(20, 8),
        block_number INTEGER,
        status VARCHAR(50) DEFAULT 'pending',
        network VARCHAR(50) DEFAULT 'localhost',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES checkout_orders(order_id) ON DELETE CASCADE
      )
    `);
    
    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_checkout_orders_vendor 
      ON checkout_orders(vendor_address)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_checkout_orders_customer 
      ON checkout_orders(customer_address)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_checkout_orders_status 
      ON checkout_orders(status)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_checkout_order_items_order 
      ON checkout_order_items(order_id)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_vendor_api_keys_vendor 
      ON vendor_api_keys(vendor_address)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_vendor_api_keys_key 
      ON vendor_api_keys(api_key)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_vendor_webhooks_order 
      ON vendor_webhooks(order_id)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_checkout_transactions_order 
      ON checkout_transactions(order_id)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_checkout_transactions_hash 
      ON checkout_transactions(transaction_hash)
    `);
    
    // Create composite index for duplicate order checking (improves performance)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_checkout_orders_duplicate_check 
      ON checkout_orders(vendor_address, customer_address, network, status, expires_at, created_at)
      WHERE status IN ('pending', 'paid', 'confirmed')
    `);
    
    // Create index on order_items for faster product matching
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_checkout_order_items_product 
      ON checkout_order_items(order_id, product_id, product_name)
    `);
    
    console.log('✅ Checkout tables created successfully');
    console.log('✅ Duplicate prevention indexes created');
    process.exit(0);
  } catch (error) {
    console.error('Error creating checkout tables:', error);
    process.exit(1);
  }
}

createCheckoutTables();

