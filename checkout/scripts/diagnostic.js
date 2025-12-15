const { Pool } = require('pg');
const checkoutContract = require('../helpers/contract');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const DIAGNOSTIC_RESULTS = {
  passed: [],
  failed: [],
  warnings: []
};

function logPass(message) {
  console.log(`✅ ${message}`);
  DIAGNOSTIC_RESULTS.passed.push(message);
}

function logFail(message, error = null) {
  console.log(`❌ ${message}`);
  if (error) console.log(`   Error: ${error.message}`);
  DIAGNOSTIC_RESULTS.failed.push({ message, error: error?.message });
}

function logWarning(message) {
  console.log(`⚠️  ${message}`);
  DIAGNOSTIC_RESULTS.warnings.push(message);
}

async function checkDatabase() {
  console.log('\n📊 Checking Database...');
  
  try {
    // Test connection
    await pool.query('SELECT NOW()');
    logPass('Database connection successful');
  } catch (error) {
    logFail('Database connection failed', error);
    return false;
  }

  // Check tables exist
  const tables = [
    'checkout_orders',
    'checkout_order_items',
    'vendor_api_keys',
    'vendor_webhooks',
    'checkout_transactions'
  ];

  for (const table of tables) {
    try {
      const result = await pool.query(
        `SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = $1
        )`,
        [table]
      );
      
      if (result.rows[0].exists) {
        logPass(`Table ${table} exists`);
      } else {
        logFail(`Table ${table} does not exist`);
      }
    } catch (error) {
      logFail(`Error checking table ${table}`, error);
    }
  }

  return true;
}

async function checkContractConfig() {
  console.log('\n📋 Checking Contract Configuration...');
  
  const configPath = path.join(__dirname, '../config/checkout-contract.json');
  
  if (fs.existsSync(configPath)) {
    logPass('Contract config file exists');
    
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      
      if (config.contractAddress) {
        logPass(`Contract address found: ${config.contractAddress}`);
      } else {
        logFail('Contract address missing in config file');
      }
      
      if (config.abi && config.abi.length > 0) {
        logPass(`Contract ABI loaded (${config.abi.length} functions)`);
      } else {
        logWarning('Contract ABI missing or empty in config file');
      }
      
      if (config.network) {
        logPass(`Network configured: ${config.network}`);
      } else {
        logWarning('Network not specified in config file');
      }
      
      return config;
    } catch (error) {
      logFail('Error reading contract config file', error);
      return null;
    }
  } else {
    logFail('Contract config file does not exist');
    logWarning('Run: npx hardhat run scripts/deploy-checkout.js --network localhost');
    return null;
  }
}

async function checkBlockchainConnection(network = 'localhost') {
  console.log(`\n⛓️  Checking Blockchain Connection (${network})...`);
  
  try {
    const contract = await checkoutContract.getContract(network);
    logPass(`Contract instance created for ${network}`);
    
    // Test contract method
    try {
      const exists = await contract.orderExists(ethers.ZeroHash);
      logPass('Contract method orderExists() is callable');
    } catch (error) {
      logFail('Contract method orderExists() failed', error);
    }
    
    // Check contract address
    const address = await contract.getAddress();
    logPass(`Contract address: ${address}`);
    
    // Verify contract code
    const provider = contract.runner.provider;
    const code = await provider.getCode(address);
    if (code !== '0x' && code !== '0x0') {
      logPass('Contract code verified at address');
    } else {
      logFail('Contract code not found at address');
    }
    
    return true;
  } catch (error) {
    logFail(`Blockchain connection failed for ${network}`, error);
    return false;
  }
}

async function checkAPIEndpoints() {
  console.log('\n🔌 Checking API Endpoints...');
  
  const endpoints = [
    '/api/checkout/register-vendor',
    '/api/checkout/create-order',
    '/api/checkout/order/:id',
    '/api/checkout/confirm-payment',
    '/api/checkout/cancel-payment',
    '/api/checkout/refund'
  ];
  
  // Check if routes are registered
  try {
    const serverPath = path.join(__dirname, '../../server.js');
    const serverContent = fs.readFileSync(serverPath, 'utf8');
    
    if (serverContent.includes('/api/checkout')) {
      logPass('Checkout routes registered in server.js');
    } else {
      logFail('Checkout routes not found in server.js');
    }
  } catch (error) {
    logWarning('Could not verify route registration');
  }
  
  endpoints.forEach(endpoint => {
    logPass(`Endpoint defined: ${endpoint}`);
  });
}

async function checkEnvironmentVariables() {
  console.log('\n🔐 Checking Environment Variables...');
  
  const required = ['DATABASE_URL'];
  const optional = ['CHECKOUT_CONTRACT_ADDRESS', 'CHECKOUT_CONTRACT_OWNER', 'GANACHE_URL'];
  
  required.forEach(varName => {
    if (process.env[varName]) {
      logPass(`${varName} is set`);
    } else {
      logFail(`${varName} is not set`);
    }
  });
  
  optional.forEach(varName => {
    if (process.env[varName]) {
      logPass(`${varName} is set`);
    } else {
      logWarning(`${varName} is not set (optional)`);
    }
  });
}

async function runDiagnostics() {
  console.log('='.repeat(60));
  console.log('🔍 CHECKOUT SYSTEM DIAGNOSTIC');
  console.log('='.repeat(60));
  
  // Run all checks
  await checkEnvironmentVariables();
  const dbOk = await checkDatabase();
  const config = await checkContractConfig();
  
  if (config) {
    await checkBlockchainConnection(config.network || 'localhost');
  } else {
    logWarning('Skipping blockchain checks - contract config not found');
  }
  
  await checkAPIEndpoints();
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 DIAGNOSTIC SUMMARY');
  console.log('='.repeat(60));
  console.log(`✅ Passed: ${DIAGNOSTIC_RESULTS.passed.length}`);
  console.log(`❌ Failed: ${DIAGNOSTIC_RESULTS.failed.length}`);
  console.log(`⚠️  Warnings: ${DIAGNOSTIC_RESULTS.warnings.length}`);
  
  if (DIAGNOSTIC_RESULTS.failed.length > 0) {
    console.log('\n❌ Failed Checks:');
    DIAGNOSTIC_RESULTS.failed.forEach(({ message, error }) => {
      console.log(`   - ${message}`);
      if (error) console.log(`     Error: ${error}`);
    });
  }
  
  if (DIAGNOSTIC_RESULTS.warnings.length > 0) {
    console.log('\n⚠️  Warnings:');
    DIAGNOSTIC_RESULTS.warnings.forEach(message => {
      console.log(`   - ${message}`);
    });
  }
  
  console.log('\n' + '='.repeat(60));
  
  if (DIAGNOSTIC_RESULTS.failed.length === 0) {
    console.log('✅ All critical checks passed!');
    process.exit(0);
  } else {
    console.log('❌ Some checks failed. Please fix the issues above.');
    process.exit(1);
  }
}

runDiagnostics().catch(error => {
  console.error('\n❌ Diagnostic script failed:', error);
  process.exit(1);
});

