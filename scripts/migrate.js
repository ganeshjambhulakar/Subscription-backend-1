const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function migrate() {
  try {
    console.log('Running database migrations...');
    
    // Create subscription_plans table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscription_plans (
        id SERIAL PRIMARY KEY,
        plan_id VARCHAR(255) UNIQUE NOT NULL,
        vendor_address VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        price NUMERIC(20, 8) NOT NULL,
        duration INTEGER NOT NULL,
        max_subscriptions INTEGER DEFAULT 0,
        active BOOLEAN DEFAULT true,
        pause_enabled BOOLEAN DEFAULT false,
        max_pause_attempts INTEGER DEFAULT 0,
        app_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Add missing columns to subscription_plans if they don't exist
    try {
      await pool.query(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS pause_enabled BOOLEAN DEFAULT false`);
      await pool.query(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_pause_attempts INTEGER DEFAULT 0`);
      await pool.query(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS app_id VARCHAR(255)`);
    } catch (e) {
      // Columns might already exist, ignore
    }
    
    // Create subscriptions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        token_id VARCHAR(255) UNIQUE NOT NULL,
        plan_id VARCHAR(255) NOT NULL,
        subscriber_address VARCHAR(255) NOT NULL,
        token_uri TEXT,
        transaction_hash VARCHAR(255),
        paused BOOLEAN DEFAULT false,
        pause_attempts INTEGER DEFAULT 0,
        total_paused_time INTEGER DEFAULT 0,
        published BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (plan_id) REFERENCES subscription_plans(plan_id)
      )
    `);
    
    // Add pause and publish columns to subscriptions if they don't exist
    try {
      await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS paused BOOLEAN DEFAULT false`);
      await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS pause_attempts INTEGER DEFAULT 0`);
      await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS total_paused_time INTEGER DEFAULT 0`);
      await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS published BOOLEAN DEFAULT true`);
    } catch (e) {
      // Columns might already exist, ignore
    }
    
    // Create customer_profiles table for vendor customer management
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customer_profiles (
        id SERIAL PRIMARY KEY,
        customer_address VARCHAR(255) NOT NULL,
        vendor_address VARCHAR(255) NOT NULL,
        first_purchase_date TIMESTAMP,
        last_purchase_date TIMESTAMP,
        total_spent NUMERIC(20, 8) DEFAULT 0,
        total_subscriptions INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(customer_address, vendor_address)
      )
    `);
    
    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_subscriber 
      ON subscriptions(subscriber_address)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_plan 
      ON subscriptions(plan_id)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_plans_vendor 
      ON subscription_plans(vendor_address)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_customer_profiles_vendor 
      ON customer_profiles(vendor_address)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_customer_profiles_customer 
      ON customer_profiles(customer_address)
    `);
    
    // ---------------------------------------------------------------------
    // Contract deployments (multi-chain support)
    // ---------------------------------------------------------------------
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contract_deployments (
        id SERIAL PRIMARY KEY,
        network VARCHAR(100),
        chain_id INTEGER NOT NULL,
        contract_type VARCHAR(50) NOT NULL DEFAULT 'unified',
        contract_address VARCHAR(255) NOT NULL,
        rpc_url TEXT,
        deployed_via VARCHAR(50) DEFAULT 'unknown',
        deployer_address VARCHAR(255),
        transaction_hash VARCHAR(255),
        block_number INTEGER,
        abi_path TEXT,
        abi_json JSONB,
        abi_version VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // If this table existed previously, it likely had a UNIQUE(network) constraint.
    // Drop it so we can support multiple entries across chains (and look up by chain_id).
    try {
      await pool.query(`ALTER TABLE contract_deployments DROP CONSTRAINT IF EXISTS contract_deployments_network_key`);
    } catch (e) {
      // Ignore
    }

    // Add missing columns for older installs (idempotent)
    try {
      await pool.query(`ALTER TABLE contract_deployments ADD COLUMN IF NOT EXISTS contract_type VARCHAR(50) NOT NULL DEFAULT 'unified'`);
      await pool.query(`ALTER TABLE contract_deployments ADD COLUMN IF NOT EXISTS rpc_url TEXT`);
      await pool.query(`ALTER TABLE contract_deployments ADD COLUMN IF NOT EXISTS deployed_via VARCHAR(50) DEFAULT 'unknown'`);
      await pool.query(`ALTER TABLE contract_deployments ADD COLUMN IF NOT EXISTS abi_json JSONB`);
      await pool.query(`ALTER TABLE contract_deployments ADD COLUMN IF NOT EXISTS abi_version VARCHAR(100)`);
      await pool.query(`ALTER TABLE contract_deployments ALTER COLUMN network DROP NOT NULL`);
    } catch (e) {
      // Ignore (column/alter may not be supported on some states)
    }

    // If older installs inserted multiple rows with the same chain_id (e.g., localhost + ganache both 1337),
    // dedupe before we create the UNIQUE(chain_id, contract_type) index.
    try {
      await pool.query(`
        WITH ranked AS (
          SELECT
            id,
            chain_id,
            contract_type,
            ROW_NUMBER() OVER (
              PARTITION BY chain_id, contract_type
              ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
            ) AS rn
          FROM contract_deployments
        )
        DELETE FROM contract_deployments
        WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
      `);
    } catch (e) {
      // Ignore
    }

    // Ensure a uniqueness key for upserts by chain + contract type
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_contract_deployments_chain_type
      ON contract_deployments(chain_id, contract_type)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_contract_deployments_chain_id
      ON contract_deployments(chain_id)
    `);
    
    console.log('✅ Database migrations completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  }
}

migrate();

