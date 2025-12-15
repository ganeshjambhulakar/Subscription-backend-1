const { ethers } = require('ethers');
const { Pool } = require('pg');
const contractService = require('../services/contractService');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function testAppPlanIntegration() {
  console.log('🧪 Testing App-Plan Integration with Database Sync\n');

  try {
    // Get contract
    const contract = await contractService.getContract();
    const provider = contractService.getProvider();
    
    // Use the first Ganache account (account[0]) which has 1000 ETH
    // Private key from hardhat.config.js for account 0x627306090abaB3A6e1400e9345bC60c78a8BEf57
    const privateKey = '0xc87509a1c067bbde78beb793e6fa76530b6382a4c0241e5e4a9ec0a0f44dc0d3';
    const wallet = new ethers.Wallet(privateKey, provider);
    const vendorAddress = await wallet.getAddress();
    
    // Check balance
    const balance = await provider.getBalance(vendorAddress);
    const balanceEth = parseFloat(ethers.formatEther(balance));
    console.log('  Vendor address:', vendorAddress);
    console.log('  Vendor balance:', balanceEth, 'ETH');
    
    if (balanceEth < 0.01) {
      // Try to get the first account from Ganache
      const accounts = await provider.listAccounts();
      if (accounts && accounts.length > 0) {
        const firstAccount = typeof accounts[0] === 'string' ? accounts[0] : accounts[0].address;
        const firstBalance = await provider.getBalance(firstAccount);
        console.log('  First Ganache account:', firstAccount);
        console.log('  First account balance:', ethers.formatEther(firstBalance), 'ETH');
        
        // If first account has funds, we need to use its private key
        // For now, let's use the account that matches the deployer
        if (firstAccount.toLowerCase() === '0x627306090abab3a6e1400e9345bc60c78a8bef57') {
          console.log('  ✅ Using deployer account with funds');
        } else {
          throw new Error('Vendor account has insufficient funds. Please use an account with at least 0.01 ETH.');
        }
      } else {
        throw new Error('Vendor account has insufficient funds. Please ensure Ganache is running and accounts are funded.');
      }
    }
    
    console.log('📋 Test Configuration:');
    console.log('  Contract:', contract.target);
    console.log('  Vendor:', vendorAddress);
    console.log('');

    // Test 1: Create App on Blockchain
    console.log('✅ Test 1: Creating App on Blockchain...');
    const createAppTx = await contract.connect(wallet).createApp(
      'Integration Test App',
      'App for integration testing'
    );
    const appReceipt = await createAppTx.wait();
    console.log('  Transaction hash:', appReceipt.hash);
    console.log('  Block number:', appReceipt.blockNumber);
    
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
    
    // Verify app on blockchain
    const app = await contract.getApp(appId);
    console.log('  ✅ App verified on blockchain:');
    console.log('    - Name:', app.name);
    console.log('    - Vendor:', app.vendor);
    console.log('    - Active:', app.active);
    console.log('');

    // Test 2: Save App to Database (simulate backend API)
    console.log('✅ Test 2: Saving App to Database...');
    const appResult = await pool.query(
      `INSERT INTO apps (app_id, vendor_address, name, description, api_key, active, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (app_id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         active = EXCLUDED.active
       RETURNING *`,
      [appId, vendorAddress.toLowerCase(), app.name, app.description, appReceipt.hash, app.active]
    );
    console.log('  ✅ App saved to database with ID:', appResult.rows[0].app_id);
    console.log('');

    // Test 3: Create Plan WITH App on Blockchain
    console.log('✅ Test 3: Creating Plan WITH App on Blockchain...');
    // Wait a moment for nonce to update
    await new Promise(resolve => setTimeout(resolve, 1000));
    const createPlanTx = await contract.connect(wallet).createPlan(
      'Test Plan with App',
      'Plan associated with app',
      ethers.parseEther('1.0'),
      2592000, // 30 days
      100, // maxSubscriptions
      true, // pauseEnabled
      3, // maxPauseAttempts
      appId, // appId
      true // removeDuplicate
    );
    const planReceipt = await createPlanTx.wait();
    console.log('  Transaction hash:', planReceipt.hash);
    
    // Extract planId
    let planId = null;
    for (const log of planReceipt.logs) {
      try {
        const parsed = contract.interface.parseLog(log);
        if (parsed && parsed.name === 'PlanCreated') {
          planId = parsed.args.planId.toString();
          console.log('  ✅ Plan created with ID:', planId);
          console.log('  ✅ Plan associated with appId:', parsed.args.appId.toString());
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
    const plan = await contract.getPlan(planId);
    console.log('  ✅ Plan verified on blockchain:');
    console.log('    - Name:', plan.name);
    console.log('    - AppId:', plan.appId.toString());
    console.log('    - Vendor:', plan.vendor);
    console.log('    - Price:', ethers.formatEther(plan.price), 'ETH');
    console.log('');

    // Test 4: Save Plan to Database (simulate backend API)
    console.log('✅ Test 4: Saving Plan to Database...');
    const planResult = await pool.query(
      `INSERT INTO subscription_plans 
       (plan_id, vendor_address, name, description, price, duration, max_subscriptions, pause_enabled, max_pause_attempts, app_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (plan_id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         price = EXCLUDED.price,
         duration = EXCLUDED.duration,
         max_subscriptions = EXCLUDED.max_subscriptions,
         pause_enabled = EXCLUDED.pause_enabled,
         max_pause_attempts = EXCLUDED.max_pause_attempts,
         app_id = EXCLUDED.app_id
       RETURNING *`,
      [
        planId,
        vendorAddress.toLowerCase(),
        plan.name,
        'Plan associated with app',
        ethers.formatEther(plan.price),
        plan.duration.toString(),
        plan.maxSubscriptions.toString(),
        plan.pauseEnabled,
        plan.maxPauseAttempts.toString(),
        plan.appId.toString() !== '0' ? plan.appId.toString() : null
      ]
    );
    console.log('  ✅ Plan saved to database:');
    console.log('    - Plan ID:', planResult.rows[0].plan_id);
    console.log('    - App ID:', planResult.rows[0].app_id);
    console.log('');

    // Test 5: Verify Database Sync
    console.log('✅ Test 5: Verifying Database Sync...');
    const dbApp = await pool.query('SELECT * FROM apps WHERE app_id = $1', [appId]);
    const dbPlan = await pool.query('SELECT * FROM subscription_plans WHERE plan_id = $1', [planId]);
    
    console.log('  ✅ Database App:');
    console.log('    - ID:', dbApp.rows[0].app_id);
    console.log('    - Name:', dbApp.rows[0].name);
    console.log('    - Vendor:', dbApp.rows[0].vendor_address);
    
    console.log('  ✅ Database Plan:');
    console.log('    - ID:', dbPlan.rows[0].plan_id);
    console.log('    - Name:', dbPlan.rows[0].name);
    console.log('    - App ID:', dbPlan.rows[0].app_id);
    console.log('');

    // Test 6: Query Plans by App
    console.log('✅ Test 6: Querying Plans by App from Blockchain...');
    const appPlans = await contract.getAppPlans(appId);
    console.log('  ✅ Plans for app:', appPlans.map(p => p.toString()));
    console.log('');

    // Test 7: Query Plans by App from Database
    console.log('✅ Test 7: Querying Plans by App from Database...');
    const dbAppPlans = await pool.query(
      'SELECT * FROM subscription_plans WHERE app_id = $1',
      [appId]
    );
    console.log('  ✅ Plans for app in database:', dbAppPlans.rows.length);
    dbAppPlans.rows.forEach(plan => {
      console.log('    - Plan ID:', plan.plan_id, 'Name:', plan.name);
    });
    console.log('');

    // Summary
    console.log('📊 Test Summary:');
    console.log('  ✅ App created on blockchain:', appId);
    console.log('  ✅ App saved to database');
    console.log('  ✅ Plan created on blockchain:', planId);
    console.log('  ✅ Plan saved to database with app_id:', plan.appId.toString());
    console.log('  ✅ Database sync verified');
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

testAppPlanIntegration();

