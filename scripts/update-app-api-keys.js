const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function updateAppApiKeys() {
  try {
    console.log('Updating app API keys to use blockchain appId...');
    
    // Update all apps to use their app_id as the api_key
    const result = await pool.query(
      `UPDATE apps 
       SET api_key = app_id 
       WHERE api_key != app_id OR api_key IS NULL`
    );
    
    console.log(`✅ Updated ${result.rowCount} app(s) to use blockchain appId as API key`);
    
    // Verify the update
    const verifyResult = await pool.query(
      `SELECT COUNT(*) as count FROM apps WHERE api_key != app_id`
    );
    
    if (parseInt(verifyResult.rows[0].count) === 0) {
      console.log('✅ All apps now use blockchain appId as API key');
    } else {
      console.warn(`⚠️ ${verifyResult.rows[0].count} app(s) still have mismatched API keys`);
    }
    
    process.exit(0);
  } catch (error) {
    console.error('Error updating app API keys:', error);
    process.exit(1);
  }
}

updateAppApiKeys();

