const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function fixMissingColumns() {
  try {
    console.log('🔧 Fixing missing columns...\n');
    
    // Fix apps table
    console.log('📋 Fixing apps table...');
    await pool.query(`
      ALTER TABLE apps 
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    `);
    console.log('✅ apps.updated_at added');
    
    // Fix subscription_plans table
    console.log('📋 Fixing subscription_plans table...');
    await pool.query(`
      ALTER TABLE subscription_plans 
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    `);
    console.log('✅ subscription_plans.updated_at added');
    
    // Fix subscriptions table
    console.log('📋 Fixing subscriptions table...');
    await pool.query(`
      ALTER TABLE subscriptions 
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    `);
    console.log('✅ subscriptions.updated_at added');
    
    // Fix customer_profiles table
    console.log('📋 Fixing customer_profiles table...');
    await pool.query(`
      ALTER TABLE customer_profiles 
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    `);
    console.log('✅ customer_profiles.updated_at added');
    
    // Fix vendor_profiles table
    console.log('📋 Fixing vendor_profiles table...');
    
    // Check if vendor_profiles table exists, create if not
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'vendor_profiles'
      )
    `);
    
    if (!tableCheck.rows[0].exists) {
      console.log('📋 Creating vendor_profiles table...');
      await pool.query(`
        CREATE TABLE vendor_profiles (
          id SERIAL PRIMARY KEY,
          vendor_address VARCHAR(255) UNIQUE NOT NULL,
          name VARCHAR(255),
          email VARCHAR(255),
          network VARCHAR(50) DEFAULT 'localhost',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('✅ vendor_profiles table created');
    } else {
      await pool.query(`
        ALTER TABLE vendor_profiles 
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ADD COLUMN IF NOT EXISTS network VARCHAR(50) DEFAULT 'localhost'
      `);
      console.log('✅ vendor_profiles columns added');
    }
    
    // Add missing columns to subscriptions if needed
    console.log('📋 Checking subscriptions table for missing columns...');
    await pool.query(`
      ALTER TABLE subscriptions 
      ADD COLUMN IF NOT EXISTS start_time BIGINT,
      ADD COLUMN IF NOT EXISTS end_time BIGINT,
      ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true
    `);
    console.log('✅ subscriptions columns verified');
    
    // Add missing columns to apps if needed
    console.log('📋 Checking apps table for missing columns...');
    await pool.query(`
      ALTER TABLE apps 
      ADD COLUMN IF NOT EXISTS block_number INTEGER,
      ADD COLUMN IF NOT EXISTS transaction_hash VARCHAR(255)
    `);
    console.log('✅ apps columns verified');
    
    // Add missing columns to subscription_plans if needed
    console.log('📋 Checking subscription_plans table for missing columns...');
    await pool.query(`
      ALTER TABLE subscription_plans 
      ADD COLUMN IF NOT EXISTS app_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS block_number INTEGER,
      ADD COLUMN IF NOT EXISTS transaction_hash VARCHAR(255),
      ADD COLUMN IF NOT EXISTS network VARCHAR(50) DEFAULT 'localhost'
    `);
    console.log('✅ subscription_plans columns verified');
    
    // Add network column to apps if needed
    console.log('📋 Checking apps table for network column...');
    await pool.query(`
      ALTER TABLE apps 
      ADD COLUMN IF NOT EXISTS network VARCHAR(50) DEFAULT 'localhost'
    `);
    console.log('✅ apps.network column verified');
    
    // Create contract_deployments table
    console.log('📋 Creating contract_deployments table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contract_deployments (
        id SERIAL PRIMARY KEY,
        network VARCHAR(50) UNIQUE NOT NULL,
        chain_id INTEGER NOT NULL,
        contract_address VARCHAR(255) NOT NULL,
        deployer_address VARCHAR(255),
        transaction_hash VARCHAR(255),
        block_number INTEGER,
        abi_path TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ contract_deployments table created');
    
    // Create index
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_contract_deployments_network 
      ON contract_deployments(network)
    `);
    console.log('✅ Index created for contract_deployments');
    
    // Insert current localhost deployment if it exists in config
    try {
      const fs = require('fs');
      const path = require('path');
      const configPath = path.join(__dirname, '../config/contract-address.json');
      
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config.contractAddress) {
          await pool.query(
            `INSERT INTO contract_deployments (network, chain_id, contract_address, deployer_address)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (network) DO UPDATE SET
               contract_address = EXCLUDED.contract_address,
               chain_id = EXCLUDED.chain_id,
               deployer_address = EXCLUDED.deployer_address,
               updated_at = CURRENT_TIMESTAMP`,
            ['localhost', parseInt(config.chainId) || 1337, config.contractAddress, config.deployer || null]
          );
          console.log('✅ Inserted localhost deployment from config file');
        }
      }
    } catch (e) {
      console.warn('⚠️ Could not insert localhost deployment:', e.message);
    }
    
    console.log('\n✅ All missing columns fixed!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error fixing columns:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

fixMissingColumns();

