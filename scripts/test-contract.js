const { ethers } = require('ethers');
const contractService = require('../services/contractService');

async function testContract() {
  try {
    const provider = contractService.getProvider();
    const contract = await contractService.getContract();
    
    console.log('Contract address:', contract.target);
    console.log('Testing contract functions...');
    
    // Test 1: Check if contract exists
    const code = await provider.getCode(contract.target);
    console.log('Contract code length:', code.length);
    if (code === '0x') {
      console.error('❌ No contract code at this address!');
      return;
    }
    
    // Test 2: Try to call a view function
    try {
      // Try to get owner (if contract has owner)
      const owner = await contract.owner();
      console.log('✅ Contract owner:', owner);
    } catch (e) {
      console.log('⚠️ Could not get owner:', e.message);
    }
    
    // Test 3: Check if we can call getVendorPlans
    const testAddress = '0x627306090abaB3A6e1400e9345bC60c78a8BEf57';
    try {
      const plans = await contract.getVendorPlans(testAddress);
      console.log('✅ getVendorPlans works! Plans:', plans.length);
    } catch (e) {
      console.error('❌ getVendorPlans failed:', e.message);
    }
    
    // Test 4: Try to create a plan (read-only simulation)
    try {
      const [signer] = await ethers.getSigners();
      const testTx = await contract.createPlan.populateTransaction(
        'Test Plan',
        'Test Description',
        ethers.parseEther('1.0'),
        86400,
        0
      );
      console.log('✅ createPlan function exists');
      console.log('   Function data:', testTx.data.substring(0, 20));
    } catch (e) {
      console.error('❌ createPlan failed:', e.message);
    }
    
  } catch (error) {
    console.error('Error testing contract:', error);
  }
}

testContract();

