const { ethers } = require('ethers');
const { Pool } = require('pg');
const contractService = require('../services/contractService');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function testPlanAppAssociation() {
  console.log('🧪 Testing Plan-App Association\n');

  try {
    // Get contract
    const contract = await contractService.getContract();
    const provider = contractService.getProvider();
    
    // Use the deployer account
    const privateKey = '0xc87509a1c067bbde78beb793e6fa76530b6382a4c0241e5e4a9ec0a0f44dc0d3';
    const wallet = new ethers.Wallet(privateKey, provider);
    const vendorAddress = await wallet.getAddress();
    
    console.log('📋 Test Configuration:');
    console.log('  Contract:', contract.target);
    console.log('  Vendor:', vendorAddress);
    console.log('');

    // Step 1: Create an App
    console.log('✅ Step 1: Creating App...');
    const createAppTx = await contract.connect(wallet).createApp(
      'Test App for Association',
      'Testing plan-app association'
    );
    const appReceipt = await createAppTx.wait();
    
    // Extract appId
    let appId = null;
    for (const log of appReceipt.logs) {
      try {
        const parsed = contract.interface.parseLog(log);
        if (parsed && parsed.name === 'AppCreated') {
          appId = parsed.args.appId.toString();
          break;
        }
      } catch (e) {
        continue;
      }
    }
    
    if (!appId) {
      // Fallback: sequential search
      for (let i = 1; i <= 20; i++) {
        try {
          const app = await contract.getApp(i.toString());
          if (app.appId.toString() !== '0' && app.vendor.toLowerCase() === vendorAddress.toLowerCase()) {
            appId = i.toString();
            break;
          }
        } catch (e) {
          continue;
        }
      }
    }
    
    if (!appId) {
      throw new Error('Could not determine appId');
    }
    
    console.log('  ✅ App created with ID:', appId);
    
    // Verify app
    const app = await contract.getApp(appId);
    console.log('  ✅ App verified:', app.name);
    console.log('');

    // Step 2: Create Plan WITH App (appId = appId)
    console.log('✅ Step 2: Creating Plan WITH App (appId = ' + appId + ')...');
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for nonce
    
    const createPlanTx = await contract.connect(wallet).createPlan(
      'Plan Associated with App',
      'This plan should be associated with the app',
      ethers.parseEther('2.0'),
      2592000, // 30 days
      50, // maxSubscriptions
      true, // pauseEnabled
      5, // maxPauseAttempts
      appId, // appId - THIS IS THE KEY PARAMETER
      true // removeDuplicate
    );
    
    const planReceipt = await createPlanTx.wait();
    console.log('  Transaction hash:', planReceipt.hash);
    
    // Extract planId
    let planId = null;
    let eventAppId = null;
    for (const log of planReceipt.logs) {
      try {
        const parsed = contract.interface.parseLog(log);
        if (parsed && parsed.name === 'PlanCreated') {
          planId = parsed.args.planId.toString();
          eventAppId = parsed.args.appId.toString();
          console.log('  ✅ PlanCreated event found:');
          console.log('    - Plan ID:', planId);
          console.log('    - App ID from event:', eventAppId);
          break;
        }
      } catch (e) {
        continue;
      }
    }
    
    if (!planId) {
      throw new Error('Could not determine planId from transaction');
    }
    
    console.log('');

    // Step 3: Verify Plan on Blockchain
    console.log('✅ Step 3: Verifying Plan on Blockchain...');
    const plan = await contract.getPlan(planId);
    console.log('  Plan details:');
    console.log('    - Plan ID:', plan.planId.toString());
    console.log('    - App ID:', plan.appId.toString(), '(should be', appId + ')');
    console.log('    - Name:', plan.name);
    console.log('    - Vendor:', plan.vendor);
    
    if (plan.appId.toString() !== appId) {
      console.error('  ❌ ERROR: Plan appId does not match!');
      console.error('    Expected:', appId);
      console.error('    Got:', plan.appId.toString());
      throw new Error('Plan appId mismatch');
    } else {
      console.log('  ✅ Plan appId matches appId');
    }
    console.log('');

    // Step 4: Verify App Plans Mapping
    console.log('✅ Step 4: Verifying App Plans Mapping...');
    const appPlans = await contract.getAppPlans(appId);
    console.log('  Plans for app', appId + ':', appPlans.map(p => p.toString()));
    
    if (!appPlans || appPlans.length === 0) {
      console.error('  ❌ ERROR: No plans found for app!');
      throw new Error('App plans mapping is empty');
    }
    
    const planFound = appPlans.some(p => p.toString() === planId);
    if (!planFound) {
      console.error('  ❌ ERROR: Plan not found in appPlans mapping!');
      console.error('    Looking for planId:', planId);
      console.error('    Found plans:', appPlans.map(p => p.toString()));
      throw new Error('Plan not in appPlans mapping');
    } else {
      console.log('  ✅ Plan found in appPlans mapping');
    }
    console.log('');

    // Step 5: Verify Database
    console.log('✅ Step 5: Verifying Database...');
    const dbPlan = await pool.query(
      'SELECT * FROM subscription_plans WHERE plan_id = $1',
      [planId]
    );
    
    if (dbPlan.rows.length === 0) {
      console.log('  ⚠️ Plan not found in database (may need to be created via API)');
    } else {
      console.log('  Database plan:');
      console.log('    - Plan ID:', dbPlan.rows[0].plan_id);
      console.log('    - App ID:', dbPlan.rows[0].app_id, '(should be', appId + ')');
      
      if (dbPlan.rows[0].app_id !== appId) {
        console.error('  ❌ ERROR: Database app_id does not match!');
        console.error('    Expected:', appId);
        console.error('    Got:', dbPlan.rows[0].app_id);
      } else {
        console.log('  ✅ Database app_id matches');
      }
    }
    console.log('');

    // Step 6: Test Standalone Plan (appId = 0)
    console.log('✅ Step 6: Testing Standalone Plan (appId = 0)...');
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const standalonePlanTx = await contract.connect(wallet).createPlan(
      'Standalone Plan',
      'Plan without app',
      ethers.parseEther('0.5'),
      86400, // 1 day
      0, // unlimited
      false, // pauseEnabled
      0, // maxPauseAttempts
      0, // appId = 0 (no app)
      true // removeDuplicate
    );
    
    const standaloneReceipt = await standalonePlanTx.wait();
    
    let standalonePlanId = null;
    for (const log of standaloneReceipt.logs) {
      try {
        const parsed = contract.interface.parseLog(log);
        if (parsed && parsed.name === 'PlanCreated') {
          standalonePlanId = parsed.args.planId.toString();
          const standaloneEventAppId = parsed.args.appId.toString();
          console.log('  ✅ Standalone plan created:');
          console.log('    - Plan ID:', standalonePlanId);
          console.log('    - App ID from event:', standaloneEventAppId, '(should be 0)');
          break;
        }
      } catch (e) {
        continue;
      }
    }
    
    const standalonePlan = await contract.getPlan(standalonePlanId);
    console.log('  ✅ Standalone plan verified:');
    console.log('    - App ID:', standalonePlan.appId.toString(), '(should be 0)');
    
    if (standalonePlan.appId.toString() !== '0') {
      throw new Error('Standalone plan should have appId = 0');
    }
    console.log('');

    // Summary
    console.log('📊 Test Summary:');
    console.log('  ✅ App created:', appId);
    console.log('  ✅ Plan with app created:', planId);
    console.log('  ✅ Plan appId matches:', plan.appId.toString() === appId);
    console.log('  ✅ Plan in appPlans mapping:', planFound);
    console.log('  ✅ Standalone plan created:', standalonePlanId);
    console.log('  ✅ Standalone plan appId = 0:', standalonePlan.appId.toString() === '0');
    console.log('  ✅ All tests passed!');
    
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack:', error.stack);
    await pool.end();
    process.exit(1);
  }
}

testPlanAppAssociation();

