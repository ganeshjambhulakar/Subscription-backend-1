const { ethers } = require('ethers');
const contractService = require('../services/contractService');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function verifyIntegration() {
  console.log('🔍 Verifying App-Plan Integration...\n');
  
  try {
    // 1. Verify contract is loaded
    const contract = await contractService.getContract();
    const provider = contractService.getProvider();
    console.log('✅ Contract loaded:', contract.target);
    
    // 2. Check contract code exists
    const code = await provider.getCode(contract.target);
    if (code.length < 100) {
      throw new Error('Contract code not found at address');
    }
    console.log('✅ Contract code verified (length:', code.length, 'bytes)');
    
    // 3. Verify database schema
    console.log('\n📊 Verifying database schema...');
    const schemaCheck = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'subscription_plans' 
      AND column_name = 'app_id'
    `);
    if (schemaCheck.rows.length === 0) {
      throw new Error('app_id column not found in subscription_plans table');
    }
    console.log('✅ Database schema verified (app_id column exists)');
    
    // 4. Verify contract ABI includes appId
    console.log('\n📋 Verifying contract ABI...');
    const createPlanFragment = contract.interface.getFunction('createPlan');
    if (!createPlanFragment) {
      throw new Error('createPlan function not found in ABI');
    }
    const params = createPlanFragment.inputs.map(i => i.name);
    if (!params.includes('appId')) {
      throw new Error('appId parameter not found in createPlan function');
    }
    console.log('✅ Contract ABI verified (createPlan includes appId)');
    
    // 5. Verify PlanCreated event includes appId
    const planCreatedFragment = contract.interface.getEvent('PlanCreated');
    if (!planCreatedFragment) {
      throw new Error('PlanCreated event not found in ABI');
    }
    const eventParams = planCreatedFragment.inputs.map(i => i.name);
    if (!eventParams.includes('appId')) {
      throw new Error('appId not found in PlanCreated event');
    }
    console.log('✅ PlanCreated event verified (includes appId)');
    
    // 6. Check if there are any existing apps and plans
    console.log('\n📦 Checking existing data...');
    const appsResult = await pool.query('SELECT COUNT(*) as count FROM apps');
    const plansResult = await pool.query('SELECT COUNT(*) as count FROM subscription_plans');
    console.log(`   Apps in database: ${appsResult.rows[0].count}`);
    console.log(`   Plans in database: ${plansResult.rows[0].count}`);
    
    // 7. Check plans with app_id
    const plansWithApp = await pool.query(`
      SELECT COUNT(*) as count 
      FROM subscription_plans 
      WHERE app_id IS NOT NULL AND app_id != ''
    `);
    console.log(`   Plans with app_id: ${plansWithApp.rows[0].count}`);
    
    console.log('\n✅✅✅ All verifications passed! Integration is working correctly.');
    console.log('\n📝 Summary:');
    console.log('   - Contract deployed and verified');
    console.log('   - Database schema includes app_id column');
    console.log('   - Contract ABI includes appId in createPlan');
    console.log('   - PlanCreated event includes appId');
    console.log('   - System ready for app-plan integration');
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Verification failed:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

verifyIntegration();


