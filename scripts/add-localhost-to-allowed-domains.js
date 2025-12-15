/**
 * Script to add localhost and 127.0.0.1 to allowed domains for all apps
 * This is useful for local development
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function addLocalhostToAllowedDomains() {
  try {
    console.log('🔧 Adding localhost domains to all apps...');
    
    // Get all apps
    const appsResult = await pool.query(
      `SELECT app_id, allowed_domains FROM apps`
    );
    
    const localhostDomains = ['localhost', '127.0.0.1', 'localhost:3000', 'localhost:8080', 'localhost:8081'];
    
    let updatedCount = 0;
    
    for (const app of appsResult.rows) {
      const currentDomains = app.allowed_domains || [];
      const newDomains = [...new Set([...currentDomains, ...localhostDomains])];
      
      // Only update if domains changed
      if (newDomains.length !== currentDomains.length) {
        await pool.query(
          `UPDATE apps 
           SET allowed_domains = $1, updated_at = NOW()
           WHERE app_id = $2`,
          [JSON.stringify(newDomains), app.app_id]
        );
        
        console.log(`  ✅ Updated app ${app.app_id}: Added localhost domains`);
        updatedCount++;
      } else {
        console.log(`  ⏭️  App ${app.app_id}: Already has localhost domains`);
      }
    }
    
    console.log(`\n✅ Complete! Updated ${updatedCount} app(s)`);
    console.log(`\nAdded domains: ${localhostDomains.join(', ')}`);
    
  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

// Run the script
if (require.main === module) {
  addLocalhostToAllowedDomains()
    .then(() => {
      console.log('\n✅ Script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Script failed:', error);
      process.exit(1);
    });
}

module.exports = { addLocalhostToAllowedDomains };

