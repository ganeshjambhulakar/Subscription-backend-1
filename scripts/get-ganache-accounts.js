/**
 * Script to get all Ganache accounts with private keys
 * Run: docker-compose exec backend node scripts/get-ganache-accounts.js
 */

const { ethers } = require('ethers');

const GANACHE_MNEMONIC = "candy maple cake sugar pudding cream honey rich smooth crumble sweet treat";
const GANACHE_URL = process.env.GANACHE_URL || 'http://ganache:8545';

async function getAccounts() {
  try {
    // Use ethers v5 or v6 compatible syntax
    let provider;
    if (ethers.providers) {
      // ethers v5
      provider = new ethers.providers.JsonRpcProvider(GANACHE_URL);
    } else {
      // ethers v6
      provider = new ethers.JsonRpcProvider(GANACHE_URL);
    }

    console.log('🔗 Ganache Test Accounts with Private Keys');
    console.log('='.repeat(100));
    console.log('');
    console.log('📝 Mnemonic:', GANACHE_MNEMONIC);
    console.log('');

    const accounts = [];

    for (let i = 0; i < 10; i++) {
      let wallet;
      if (ethers.utils) {
        // ethers v5
        const hdNode = ethers.utils.HDNode.fromMnemonic(GANACHE_MNEMONIC);
        const accountNode = hdNode.derivePath(`m/44'/60'/0'/0/${i}`);
        wallet = new ethers.Wallet(accountNode.privateKey, provider);
      } else {
        // ethers v6
        const mnemonic = ethers.Mnemonic.fromPhrase(GANACHE_MNEMONIC);
        const hdNode = ethers.HDNodeWallet.fromMnemonic(mnemonic);
        const accountNode = hdNode.derivePath(`44'/60'/0'/0/${i}`);
        wallet = new ethers.Wallet(accountNode.privateKey, provider);
      }

      const address = wallet.address;
      const privateKey = wallet.privateKey;
      const balance = await provider.getBalance(address);
      
      let balanceEth;
      if (ethers.utils) {
        balanceEth = parseFloat(ethers.utils.formatEther(balance));
      } else {
        balanceEth = parseFloat(ethers.formatEther(balance));
      }

      accounts.push({ index: i, address, privateKey, balance: balanceEth });

      console.log(`Account ${i + 1}:`);
      console.log(`  Address:    ${address}`);
      console.log(`  Private Key: ${privateKey}`);
      console.log(`  Balance:    ${balanceEth.toFixed(4)} ETH`);
      console.log('');
    }

    console.log('='.repeat(100));
    console.log('✅ Total accounts:', accounts.length);
    console.log('💰 Total balance:', accounts.reduce((sum, acc) => sum + acc.balance, 0).toFixed(4), 'ETH');
    console.log('');
    console.log('📄 JSON Export:');
    console.log(JSON.stringify(accounts.map(a => ({
      index: a.index,
      address: a.address,
      privateKey: a.privateKey,
      balance: a.balance
    })), null, 2));

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

getAccounts();

