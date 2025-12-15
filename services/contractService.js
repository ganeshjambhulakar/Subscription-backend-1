const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

let contracts = {}; // Store contracts per network: { network: contract }
let providers = {}; // Store providers per network: { network: provider }
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Get RPC URL for a network
 */
function getRpcUrlForNetwork(network) {
  const networkConfigs = {
    localhost: process.env.GANACHE_URL || 'http://localhost:8545',
    ganache: process.env.GANACHE_URL || 'http://ganache:8545',
    sepolia: process.env.SEPOLIA_RPC_URL || 'https://sepolia.infura.io/v3/YOUR_INFURA_KEY',
    mumbai: process.env.MUMBAI_RPC_URL || 'https://matic-mumbai.chainstacklabs.com',
    ethereum: process.env.ETHEREUM_RPC_URL || 'https://mainnet.infura.io/v3/YOUR_INFURA_KEY',
    polygon: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com'
  };
  
  return networkConfigs[network] || networkConfigs.localhost;
}

/**
 * Initialize contract service for a specific network
 */
async function initialize(network = 'localhost') {
  const rpcUrl = getRpcUrlForNetwork(network);
  
  // Initialize provider for this network
  if (!providers[network]) {
    providers[network] = new ethers.JsonRpcProvider(rpcUrl);
  }
  const provider = providers[network];
  
  // Verify provider is accessible
  try {
    const blockNumber = await provider.getBlockNumber();
    console.log(`[Contract Service] ✅ Provider connected for ${network}, current block:`, blockNumber);
  } catch (error) {
    console.error(`[Contract Service] ❌ Provider not accessible for ${network}:`, error.message);
    throw new Error(`Failed to connect to blockchain provider at ${rpcUrl} for network ${network}.`);
  }
  
  // Load contract address from database
  let contractAddress = null;
  try {
    const result = await pool.query(
      `SELECT contract_address, chain_id
       FROM contract_deployments
       WHERE network = $1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [network]
    );
    
    if (result.rows.length > 0) {
      contractAddress = result.rows[0].contract_address;
      console.log(`[Contract Service] ✅ Found contract address for ${network}: ${contractAddress}`);
    }
  } catch (dbError) {
    console.warn(`[Contract Service] ⚠️ Could not load from database, trying config file:`, dbError.message);
  }
  
  // Fallback: Load from config file if database doesn't have it
  if (!contractAddress) {
    const contractAddressPath = path.join(__dirname, '../config/contract-address.json');
    if (fs.existsSync(contractAddressPath)) {
      const deploymentInfo = JSON.parse(fs.readFileSync(contractAddressPath, 'utf8'));
      if (deploymentInfo.network === network || network === 'localhost') {
        contractAddress = deploymentInfo.contractAddress;
        console.log(`[Contract Service] ✅ Loaded contract address from config file for ${network}: ${contractAddress}`);
      }
    }
  }
  
  if (!contractAddress) {
    console.warn(`[Contract Service] ⚠️ Contract address not available for network: ${network}`);
    return null;
  }
  
  // Load contract ABI - try multiple paths
  // Try unified contract first (SubscriptionAndCheckout), then fallback to SubscriptionNFT
  let artifactsPath = null;
  let abi = null;
  
  // Try path 1: Unified contract from shared volume (Docker)
  const dockerUnifiedPath = path.join(__dirname, '../contracts/SubscriptionAndCheckout.sol/SubscriptionAndCheckout.json');
  // Try path 2: Unified contract from smart-contracts directory (local development)
  const localUnifiedPath = path.join(__dirname, '../../smart-contracts/artifacts/contracts/SubscriptionAndCheckout.sol/SubscriptionAndCheckout.json');
  // Fallback to SubscriptionNFT contract (has same functions)
  const dockerNFTPath = path.join(__dirname, '../contracts/SubscriptionNFT.sol/SubscriptionNFT.json');
  const localNFTPath = path.join(__dirname, '../../smart-contracts/artifacts/contracts/SubscriptionNFT.sol/SubscriptionNFT.json');
  
  // Try unified contract first, then fallback to SubscriptionNFT
  if (fs.existsSync(dockerUnifiedPath)) {
    artifactsPath = dockerUnifiedPath;
  } else if (fs.existsSync(localUnifiedPath)) {
    artifactsPath = localUnifiedPath;
  } else if (fs.existsSync(dockerNFTPath)) {
    artifactsPath = dockerNFTPath;
  } else if (fs.existsSync(localNFTPath)) {
    artifactsPath = localNFTPath;
  }
  
  if (artifactsPath && fs.existsSync(artifactsPath)) {
    const contractArtifact = JSON.parse(fs.readFileSync(artifactsPath, 'utf8'));
    abi = contractArtifact.abi;
  } else {
    // Fallback: Use minimal ABI if artifacts not found
    console.warn('Contract artifacts not found, using minimal ABI');
    abi = [
      // App functions
      "function createApp(string memory name, string memory description) external returns (uint256)",
      "function getApp(uint256 appId) external view returns (tuple(uint256 appId, address vendor, string name, string description, bool active, uint256 createdAt))",
      "function getVendorApps(address vendor) external view returns (uint256[] memory)",
      "function updateApp(uint256 appId, string memory name, string memory description, bool active) external",
      "function getAppPlans(uint256 appId) external view returns (uint256[] memory)",
      "function associatePlanWithApp(uint256 planId, uint256 appId) external",
      // Plan functions
      "function createPlan(string memory name, string memory description, uint256 price, uint256 duration, uint256 maxSubscriptions, bool pauseEnabled, uint256 maxPauseAttempts, uint256 appId, bool removeDuplicate) external returns (uint256)",
      "function getPlan(uint256 planId) external view returns (tuple(uint256 planId, address vendor, string name, string description, uint256 price, uint256 duration, bool active, uint256 maxSubscriptions, uint256 currentSubscriptions, bool pauseEnabled, uint256 maxPauseAttempts, uint256 appId))",
      "function getVendorPlans(address) external view returns (uint256[] memory)",
      "function removePlan(uint256 planId) external",
      // Subscription functions
      "function purchaseSubscription(uint256 planId, string memory tokenURI) external payable returns (uint256)",
      "function renewSubscription(uint256 tokenId) external payable",
      "function isSubscriptionValid(uint256 tokenId) external view returns (bool)",
      "function getSubscription(uint256 tokenId) external view returns (tuple(uint256 tokenId, uint256 planId, address subscriber, uint256 startTime, uint256 endTime, bool active, bool paused, uint256 pauseStartTime, uint256 totalPausedTime, uint256 pauseAttempts, bool published))",
      "function getUserSubscriptions(address user) external view returns (uint256[] memory)",
      "function pauseSubscription(uint256 tokenId) external",
      "function unpauseSubscription(uint256 tokenId) external",
      "function setSubscriptionPublished(uint256 tokenId, bool published) external",
      // Direct mapping access
      "function plans(uint256) external view returns (uint256 planId, address vendor, string memory name, string memory description, uint256 price, uint256 duration, bool active, uint256 maxSubscriptions, uint256 currentSubscriptions, bool pauseEnabled, uint256 maxPauseAttempts, uint256 appId)",
      "function vendorPlans(address, uint256) external view returns (uint256)",
      // Events
      "event AppCreated(uint256 indexed appId, address indexed vendor, string name)",
      "event AppUpdated(uint256 indexed appId, address indexed vendor, bool active)",
      "event PlanCreated(uint256 indexed planId, address indexed vendor, uint256 indexed appId, string name, uint256 price, uint256 duration)",
      "event PlanAssociatedWithApp(uint256 indexed planId, uint256 indexed appId, address indexed vendor)",
      "event PlanRemoved(uint256 indexed planId, address indexed vendor)",
      "event SubscriptionPurchased(uint256 indexed tokenId, uint256 indexed planId, address indexed subscriber, uint256 endTime)",
      "event SubscriptionRenewed(uint256 indexed tokenId, uint256 newEndTime)"
    ];
  }
  
  // Verify contract is deployed before creating instance
  console.log('[Contract Service] 🔍 Verifying contract deployment...');
  const code = await provider.getCode(contractAddress);
  
  if (code === '0x' || code === '0x0') {
    const errorMsg = `Contract verification failed: No contract code found at address ${contractAddress}. ` +
      `Please ensure the contract is deployed. Run: npx hardhat run scripts/deploy.js --network localhost`;
    console.error('[Contract Service] ❌', errorMsg);
    throw new Error(errorMsg);
  }
  
  console.log(`[Contract Service] ✅ Contract code verified at ${contractAddress} on ${network}`);
  
  // Create contract instance for this network
  const contractInstance = new ethers.Contract(contractAddress, abi, provider);
  contracts[network] = contractInstance;
  
  console.log(`✅ Contract service initialized for ${network}`);
  console.log(`   Contract address: ${contractAddress}`);
  
  return contractInstance;
}

/**
 * Get contract instance for a specific network with retry logic and verification
 */
async function getContract(network = 'localhost') {
  const maxRetries = 3;
  let lastError = null;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (!contracts[network]) {
        contracts[network] = await initialize(network);
        
        // If still null, wait a bit and retry (for initial deployment)
        if (!contracts[network]) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          contracts[network] = await initialize(network);
        }
        
        // If still null, try one more time with longer wait
        if (!contracts[network]) {
          await new Promise(resolve => setTimeout(resolve, 3000));
          contracts[network] = await initialize(network);
        }
      }
      
      if (contracts[network]) {
        // Verify contract is accessible
        try {
          const currentProvider = getProvider(network);
          await currentProvider.getBlockNumber();
          
          // Verify contract code exists
          try {
            const code = await currentProvider.getCode(contracts[network].target);
            if (code === '0x' || code === '0x0') {
              throw new Error('Contract code not found at address');
            }
            console.log(`[Contract Service] ✅ Contract verified and accessible for ${network}`);
            return contracts[network];
          } catch (contractVerifyError) {
            console.warn(`[Contract Service] ⚠️ Contract verification failed for ${network} (attempt ${i + 1}):`, contractVerifyError.message);
            delete contracts[network]; // Reset to force re-initialization
            if (i < maxRetries - 1) {
              await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
              continue;
            }
          }
        } catch (providerError) {
          console.warn(`[Contract Service] ⚠️ Provider not accessible for ${network} (attempt ${i + 1}), retrying...`, providerError.message);
          delete contracts[network]; // Reset to force re-initialization
          delete providers[network]; // Reset provider too
          if (i < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
            continue;
          }
        }
      }
    } catch (error) {
      lastError = error;
      console.warn(`[Contract Service] Attempt ${i + 1} failed for ${network}:`, error.message);
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
      }
    }
  }
  
  // If we get here, all retries failed
  const rpcUrl = getRpcUrlForNetwork(network);
  let contractAddress = null;
  
  try {
    const result = await pool.query(
      'SELECT contract_address FROM contract_deployments WHERE network = $1',
      [network]
    );
    if (result.rows.length > 0) {
      contractAddress = result.rows[0].contract_address;
    }
  } catch (e) {
    // Ignore
  }
  
  const errorMessage = `Contract not initialized for network ${network} after ${maxRetries} attempts. Please ensure contracts are deployed.\n` +
    `  - Network: ${network}\n` +
    `  - Contract address: ${contractAddress || 'NOT FOUND'}\n` +
    `  - RPC URL: ${rpcUrl}\n` +
    `  - Last error: ${lastError?.message || 'Unknown'}`;
  
  throw new Error(errorMessage);
}

/**
 * Get provider instance for a specific network
 */
function getProvider(network = 'localhost') {
  if (!providers[network]) {
    const rpcUrl = getRpcUrlForNetwork(network);
    providers[network] = new ethers.JsonRpcProvider(rpcUrl);
    
    // Add error handling for provider
    providers[network].on('error', (error) => {
      console.error(`[Contract Service] Provider error for ${network}:`, error);
    });
  }
  return providers[network];
}

// Initialize localhost contract on module load (skip during tests to avoid hanging Jest)
if (process.env.NODE_ENV !== 'test') {
initialize('localhost').catch(err => {
  console.warn('[Contract Service] Initial localhost initialization failed:', err.message);
});
}

module.exports = {
  getContract,
  getProvider,
  initialize
};

