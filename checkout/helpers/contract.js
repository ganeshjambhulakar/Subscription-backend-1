const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

let contracts = {}; // Store contracts per network: { network: contract }
let providers = {}; // Store providers per network: { network: provider }

/**
 * Get RPC URL for a network
 */
function getRpcUrlForNetwork(network) {
  const networkConfigs = {
    localhost: process.env.GANACHE_URL || 'http://localhost:8545',
    ganache: process.env.GANACHE_URL || 'http://ganache:8545',
    hardhat: 'http://localhost:8545',
    sepolia: process.env.SEPOLIA_RPC_URL || 'https://sepolia.infura.io/v3/YOUR_INFURA_KEY',
    mumbai: process.env.MUMBAI_RPC_URL || 'https://matic-mumbai.chainstacklabs.com',
    ethereum: process.env.ETHEREUM_RPC_URL || 'https://mainnet.infura.io/v3/YOUR_INFURA_KEY',
    polygon: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com'
  };
  
  return networkConfigs[network] || networkConfigs.localhost;
}

/**
 * Load checkout contract config
 */
function loadCheckoutConfig(network = 'localhost') {
  // Try 1: Load from config file
  const configPath = path.join(__dirname, '../config/checkout-contract.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.network === network || network === 'localhost') {
        return config;
      }
    } catch (error) {
      console.warn(`[Checkout Contract] Could not parse config file:`, error.message);
    }
  }

  // Try 2: Load from environment
  const contractAddress = process.env.CHECKOUT_CONTRACT_ADDRESS;
  if (contractAddress) {
    return {
      network,
      contractAddress,
      abi: null // Will need to load from artifacts
    };
  }

  return null;
}

/**
 * Load contract ABI
 */
function loadContractABI() {
  // Try to load from config file first
  const configPath = path.join(__dirname, '../config/checkout-contract.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.abi) {
        return config.abi;
      }
    } catch (error) {
      console.warn(`[Checkout Contract] Could not load ABI from config:`, error.message);
    }
  }

  // Try to load from artifacts (if running in same repo)
  const artifactsPath = path.join(__dirname, '../../../smart-contracts/artifacts/contracts/Checkout.sol/Checkout.json');
  if (fs.existsSync(artifactsPath)) {
    try {
      const artifact = JSON.parse(fs.readFileSync(artifactsPath, 'utf8'));
      return artifact.abi;
    } catch (error) {
      console.warn(`[Checkout Contract] Could not load ABI from artifacts:`, error.message);
    }
  }

  // Fallback: Minimal ABI for essential functions
  return [
    "function createOrder(bytes32 orderId, address vendor, uint256 totalAmount, uint256 expiresAt) external",
    "function processPayment(bytes32 orderId) external payable",
    "function confirmOrder(bytes32 orderId) external",
    "function cancelOrder(bytes32 orderId) external",
    "function customerCancelOrder(bytes32 orderId) external",
    "function refundOrder(bytes32 orderId) external",
    "function getOrder(bytes32 orderId) external view returns (tuple(bytes32 orderId, address vendor, address customer, uint256 totalAmount, uint8 status, uint256 createdAt, uint256 expiresAt, bool exists))",
    "function orderExists(bytes32 orderId) external view returns (bool)",
    "function getVendorOrders(address vendor) external view returns (bytes32[] memory)",
    "function getCustomerOrders(address customer) external view returns (bytes32[] memory)",
    "event OrderCreated(bytes32 indexed orderId, address indexed vendor, uint256 totalAmount, uint256 expiresAt)",
    "event PaymentReceived(bytes32 indexed orderId, address indexed customer, uint256 amount, bytes32 indexed txHash)",
    "event OrderConfirmed(bytes32 indexed orderId, address indexed vendor)",
    "event OrderCancelled(bytes32 indexed orderId, address indexed vendor)",
    "event RefundProcessed(bytes32 indexed orderId, address indexed customer, uint256 amount, bytes32 indexed txHash)"
  ];
}

/**
 * Initialize checkout contract for a specific network
 */
async function initialize(network = 'localhost', signerAddress = null) {
  // Check if already initialized
  if (contracts[network] && providers[network]) {
    return contracts[network];
  }

  const rpcUrl = getRpcUrlForNetwork(network);
  
  // Initialize provider
  if (!providers[network]) {
    providers[network] = new ethers.JsonRpcProvider(rpcUrl);
    
    // Verify provider is accessible
    try {
      const blockNumber = await providers[network].getBlockNumber();
      console.log(`[Checkout Contract] ✅ Provider connected for ${network}, current block:`, blockNumber);
    } catch (error) {
      console.error(`[Checkout Contract] ❌ Provider not accessible for ${network}:`, error.message);
      throw new Error(`Failed to connect to blockchain provider at ${rpcUrl} for network ${network}. Please ensure Ganache/Hardhat is running.`);
    }
  }
  const provider = providers[network];

  // Load contract config
  const config = loadCheckoutConfig(network);
  if (!config || !config.contractAddress) {
    const errorMsg = `Checkout contract not deployed. Run the deploy script first: npx hardhat run scripts/deploy-checkout.js --network ${network}`;
    console.error(`[Checkout Contract] ❌ ${errorMsg}`);
    throw new Error(errorMsg);
  }

  const contractAddress = config.contractAddress;

  // Verify contract is deployed
  const code = await provider.getCode(contractAddress);
  if (code === '0x' || code === '0x0') {
    const errorMsg = `Checkout contract not deployed at address ${contractAddress} on ${network}. Please deploy the contract first.`;
    console.error(`[Checkout Contract] ❌ ${errorMsg}`);
    throw new Error(errorMsg);
  }
  console.log(`[Checkout Contract] ✅ Contract code verified at ${contractAddress}`);

  // Load ABI
  const abi = loadContractABI();
  if (!abi || abi.length === 0) {
    throw new Error('Could not load contract ABI. Please ensure contract is compiled and artifacts exist.');
  }

  // Create contract instance
  let contract;
  if (signerAddress) {
    // Use signer if provided
    // Note: getSigner(address) doesn't work this way - we need the private key
    // For now, we'll use a wallet from private key if available
    const privateKey = process.env.CHECKOUT_CONTRACT_OWNER_PRIVATE_KEY;
    if (privateKey) {
      const wallet = new ethers.Wallet(privateKey, provider);
      contract = new ethers.Contract(contractAddress, abi, wallet);
    } else {
      // Fallback: try to use provider with signer address (may not work)
      console.warn('[Checkout Contract] CHECKOUT_CONTRACT_OWNER_PRIVATE_KEY not set. Using read-only contract.');
      contract = new ethers.Contract(contractAddress, abi, provider);
    }
  } else {
    // Use provider (read-only)
    contract = new ethers.Contract(contractAddress, abi, provider);
  }

  contracts[network] = contract;
  console.log(`[Checkout Contract] ✅ Contract initialized for ${network} at ${contractAddress}`);

  return contract;
}

/**
 * Get checkout contract instance
 */
async function getContract(network = 'localhost', signerAddress = null) {
  if (contracts[network]) {
    return contracts[network];
  }
  return await initialize(network, signerAddress);
}

/**
 * Verify contract is initialized
 */
async function verifyInitialized(network = 'localhost') {
  try {
    const contract = await getContract(network);
    // Test a simple view function
    await contract.orderExists(ethers.ZeroHash);
    return true;
  } catch (error) {
    console.error(`[Checkout Contract] ❌ Contract not initialized:`, error.message);
    return false;
  }
}

module.exports = {
  initialize,
  getContract,
  verifyInitialized,
  getRpcUrlForNetwork,
  loadCheckoutConfig,
  loadContractABI
};

