const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function createContractDeploymentsTable() {
  try {
    console.log('📋 Creating contract_deployments table...');
    
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
    
    console.log('✅ contract_deployments table created');
    
    // Create index for faster lookups
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_contract_deployments_network 
      ON contract_deployments(network)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_contract_deployments_chain_id
      ON contract_deployments(chain_id)
    `);

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_contract_deployments_chain_type
      ON contract_deployments(chain_id, contract_type)
    `);
    
    console.log('✅ Index created');
    
    // Insert default localhost deployment if it doesn't exist
    const existing = await pool.query(
      'SELECT * FROM contract_deployments WHERE chain_id = $1 AND contract_type = $2',
      [1337, 'unified']
    );
    
    if (existing.rows.length === 0) {
      // Try to load from config file
      const fs = require('fs');
      const path = require('path');
      const configPath = path.join(__dirname, '../config/contract-address.json');
      
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        await pool.query(
          `INSERT INTO contract_deployments (network, chain_id, contract_type, contract_address, rpc_url, deployed_via, deployer_address)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (chain_id, contract_type) DO UPDATE SET
             network = EXCLUDED.network,
             contract_address = EXCLUDED.contract_address,
             rpc_url = EXCLUDED.rpc_url,
             deployed_via = EXCLUDED.deployed_via,
             deployer_address = EXCLUDED.deployer_address,
             updated_at = CURRENT_TIMESTAMP`,
          [
            'localhost',
            parseInt(config.chainId) || 1337,
            'unified',
            config.contractAddress,
            process.env.GANACHE_URL || 'http://localhost:8545',
            'config',
            config.deployer || null
          ]
        );
        console.log('✅ Default localhost deployment inserted');
      }
    }
    
    console.log('✅ Migration completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration error:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

createContractDeploymentsTable();

