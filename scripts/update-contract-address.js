const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function updateContractAddress() {
  try {
    console.log('📦 Updating contract address in database...');
    
    // Use the latest deployed unified contract address
    const newAddress = '0xF12b5dd4EAD5F743C6BaA640B0216200e89B60Da';
    const network = 'localhost';
    const chainId = '1337';
    const deployer = '0x627306090abaB3A6e1400e9345bC60c78a8BEf57';
    
    // Check if record exists
    const checkResult = await pool.query(
      `SELECT * FROM contract_deployments WHERE network = $1`,
      [network]
    );
    
    if (checkResult.rows.length > 0) {
      // Update existing record
      await pool.query(
        `UPDATE contract_deployments 
         SET contract_address = $1,
             chain_id = $2,
             deployer_address = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE network = $4`,
        [newAddress, chainId, deployer, network]
      );
      console.log(`  ✅ Updated contract address for ${network}: ${newAddress}`);
    } else {
      // Insert new record
      await pool.query(
        `INSERT INTO contract_deployments 
         (network, chain_id, contract_address, deployer_address)
         VALUES ($1, $2, $3, $4)`,
        [network, chainId, newAddress, deployer]
      );
      console.log(`  ✅ Inserted contract address for ${network}: ${newAddress}`);
    }
    
    // Verify update
    const verifyResult = await pool.query(
      `SELECT contract_address FROM contract_deployments WHERE network = $1`,
      [network]
    );
    
    if (verifyResult.rows.length > 0) {
      console.log(`  ✅ Verified: Contract address is now ${verifyResult.rows[0].contract_address}`);
    }
    
    console.log('\n✅ Contract address updated successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error updating contract address:', error);
    process.exit(1);
  }
}

updateContractAddress();

