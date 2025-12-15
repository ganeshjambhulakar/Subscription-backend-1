const { ethers } = require('ethers');
const { Pool } = require('pg');
const contractService = require('../services/contractService');
const axios = require('axios');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';

async function testFullFlow() {
  console.log('🧪 Testing Full App-Plan Flow (Frontend → Backend → Database)\n');

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
    console.log('  Backend URL:', BACKEND_URL);
    console.log('');

    // Step 1: Create App via Backend API (simulates frontend flow)
    console.log('✅ Step 1: Creating App via Backend API...');
    const createAppResponse = await axios.post(`${BACKEND_URL}/api/apps`, {
      vendorAddress: vendorAddress,
      name: 'Full Flow Test App',
      description: 'Testing complete app-plan flow'
    });
    
    const createdApp = createAppResponse.data.app;
    const appId = createdApp.app_id;
    console.log('  ✅ App created via API:');
    console.log('    - App ID:', appId);
    console.log('    - Name:', createdApp.name);
    console.log('');

    // Step 2: Verify App on Blockchain
    console.log('✅ Step 2: Verifying App on Blockchain...');
    const blockchainApp = await contract.getApp(appId);
    console.log('  ✅ App verified on blockchain:');
    console.log('    - App ID:', blockchainApp.appId.toString());
    console.log('    - Name:', blockchainApp.name);
    console.log('    - Active:', blockchainApp.active);
    console.log('');

    // Step 3: Create Plan WITH App via Backend API (simulates frontend flow)
    console.log('✅ Step 3: Creating Plan WITH App via Backend API...');
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for nonce
    
    // First create plan on blockchain
    const createPlanTx = await contract.connect(wallet).createPlan(
      'Full Flow Test Plan',
      'Plan created via full flow test',
      ethers.parseEther('3.0'),
      2592000, // 30 days
      200, // maxSubscriptions
      true, // pauseEnabled
      10, // maxPauseAttempts
      appId, // appId
      true // removeDuplicate
    );
    
    const planReceipt = await createPlanTx.wait();
    console.log('  ✅ Plan created on blockchain:');
    console.log('    - Transaction hash:', planReceipt.hash);
    
    // Extract planId and appId from event
    let planId = null;
    let eventAppId = null;
    for (const log of planReceipt.logs) {
      try {
        const parsed = contract.interface.parseLog(log);
        if (parsed && parsed.name === 'PlanCreated') {
          planId = parsed.args.planId.toString();
          eventAppId = parsed.args.appId.toString();
          console.log('    - Plan ID:', planId);
          console.log('    - App ID from event:', eventAppId);
          break;
        }
      } catch (e) {
        continue;
      }
    }
    
    if (!planId) {
      throw new Error('Could not determine planId');
    }
    
    // Verify plan on blockchain
    const blockchainPlan = await contract.getPlan(planId);
    console.log('  ✅ Plan verified on blockchain:');
    console.log('    - Plan ID:', blockchainPlan.planId.toString());
    console.log('    - App ID:', blockchainPlan.appId.toString(), '(should be', appId + ')');
    
    if (blockchainPlan.appId.toString() !== appId) {
      throw new Error(`Plan appId mismatch! Expected: ${appId}, Got: ${blockchainPlan.appId.toString()}`);
    }
    console.log('');

    // Step 4: Save Plan via Backend API (simulates frontend POST)
    console.log('✅ Step 4: Saving Plan via Backend API...');
    const createPlanResponse = await axios.post(`${BACKEND_URL}/api/plans`, {
      planId: planId,
      vendorAddress: vendorAddress,
      name: blockchainPlan.name,
      description: 'Plan created via full flow test',
      price: ethers.formatEther(blockchainPlan.price),
      duration: blockchainPlan.duration.toString(),
      maxSubscriptions: blockchainPlan.maxSubscriptions.toString(),
      pauseEnabled: blockchainPlan.pauseEnabled,
      maxPauseAttempts: blockchainPlan.maxPauseAttempts.toString(),
      appId: eventAppId, // Send appId from event
      transactionHash: planReceipt.hash,
      blockNumber: planReceipt.blockNumber
    });
    
    const savedPlan = createPlanResponse.data;
    console.log('  ✅ Plan saved via API:');
    console.log('    - Plan ID:', savedPlan.plan_id);
    console.log('    - App ID:', savedPlan.app_id, '(should be', appId + ')');
    
    if (savedPlan.app_id !== appId) {
      throw new Error(`Database app_id mismatch! Expected: ${appId}, Got: ${savedPlan.app_id}`);
    }
    console.log('');

    // Step 5: Verify Database
    console.log('✅ Step 5: Verifying Database...');
    const dbPlan = await pool.query(
      'SELECT * FROM subscription_plans WHERE plan_id = $1',
      [planId]
    );
    
    if (dbPlan.rows.length === 0) {
      throw new Error('Plan not found in database');
    }
    
    const dbPlanData = dbPlan.rows[0];
    console.log('  ✅ Database plan:');
    console.log('    - Plan ID:', dbPlanData.plan_id);
    console.log('    - App ID:', dbPlanData.app_id, '(should be', appId + ')');
    console.log('    - Name:', dbPlanData.name);
    
    if (dbPlanData.app_id !== appId) {
      throw new Error(`Database app_id does not match! Expected: ${appId}, Got: ${dbPlanData.app_id}`);
    }
    console.log('');

    // Step 6: Verify App Plans Query
    console.log('✅ Step 6: Verifying App Plans Query...');
    const blockchainAppPlans = await contract.getAppPlans(appId);
    console.log('  ✅ Plans for app from blockchain:', blockchainAppPlans.map(p => p.toString()));
    
    const dbAppPlans = await pool.query(
      'SELECT * FROM subscription_plans WHERE app_id = $1',
      [appId]
    );
    console.log('  ✅ Plans for app from database:', dbAppPlans.rows.length);
    dbAppPlans.rows.forEach(plan => {
      console.log('    - Plan ID:', plan.plan_id, 'Name:', plan.name);
    });
    
    const planFoundInBlockchain = blockchainAppPlans.some(p => p.toString() === planId);
    const planFoundInDatabase = dbAppPlans.rows.some(p => p.plan_id === planId);
    
    if (!planFoundInBlockchain) {
      throw new Error('Plan not found in blockchain appPlans mapping');
    }
    if (!planFoundInDatabase) {
      throw new Error('Plan not found in database with app_id');
    }
    console.log('');

    // Summary
    console.log('📊 Full Flow Test Summary:');
    console.log('  ✅ App created via API');
    console.log('  ✅ App verified on blockchain');
    console.log('  ✅ Plan created on blockchain with appId:', appId);
    console.log('  ✅ Plan saved via API with appId:', appId);
    console.log('  ✅ Database app_id matches blockchain appId');
    console.log('  ✅ Plan found in appPlans mapping');
    console.log('  ✅ Plan found in database with app_id');
    console.log('  ✅ All tests passed!');
    
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('  API Error:', error.response.data);
    }
    console.error('Stack:', error.stack);
    await pool.end();
    process.exit(1);
  }
}

testFullFlow();

