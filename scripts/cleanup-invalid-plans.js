const { Pool } = require('pg');
const contractService = require('../services/contractService');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Cleanup script to remove plans from database that don't exist on blockchain
 */
async function cleanupInvalidPlans() {
  try {
    console.log('🧹 Starting cleanup of invalid plans...');
    
    // Initialize contract service
    await contractService.initialize('localhost');
    const contract = await contractService.getContract('localhost');
    
    // Get all plans from database
    const dbPlans = await pool.query('SELECT plan_id, vendor_address, name FROM subscription_plans');
    console.log(`📋 Found ${dbPlans.rows.length} plans in database`);
    
    const invalidPlans = [];
    
    for (const dbPlan of dbPlans.rows) {
      try {
        const planId = dbPlan.plan_id.toString();
        const blockchainPlan = await contract.getPlan(planId);
        
        // Check if plan exists on blockchain
        if (!blockchainPlan || blockchainPlan.planId.toString() === '0') {
          console.log(`❌ Plan ${planId} (${dbPlan.name}) does not exist on blockchain`);
          invalidPlans.push(dbPlan);
        } else {
          console.log(`✅ Plan ${planId} (${dbPlan.name}) exists on blockchain`);
        }
      } catch (error) {
        console.log(`❌ Plan ${dbPlan.plan_id} (${dbPlan.name}) - Error checking: ${error.message}`);
        invalidPlans.push(dbPlan);
      }
    }
    
    if (invalidPlans.length === 0) {
      console.log('\n✅ All plans in database exist on blockchain!');
      return;
    }
    
    console.log(`\n⚠️  Found ${invalidPlans.length} invalid plans:`);
    invalidPlans.forEach(plan => {
      console.log(`   - Plan ${plan.plan_id}: ${plan.name} (Vendor: ${plan.vendor_address})`);
    });
    
    console.log('\n💡 These plans will be removed from the database.');
    console.log('💡 To keep them, cancel this script (Ctrl+C)');
    console.log('\n⏳ Waiting 5 seconds before deletion...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Delete invalid plans
    for (const plan of invalidPlans) {
      await pool.query('DELETE FROM subscription_plans WHERE plan_id = $1', [plan.plan_id]);
      console.log(`🗑️  Deleted plan ${plan.plan_id} from database`);
    }
    
    console.log(`\n✅ Cleanup complete! Removed ${invalidPlans.length} invalid plans.`);
    
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during cleanup:', error);
    await pool.end();
    process.exit(1);
  }
}

cleanupInvalidPlans();

