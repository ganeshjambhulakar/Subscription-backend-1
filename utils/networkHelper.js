const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Get network from request (vendor profile, query param, or default)
 */
async function getNetworkFromRequest(req) {
  // Priority 1: Query parameter
  if (req.query && req.query.network) {
    return req.query.network;
  }
  
  // Priority 2: Body parameter
  if (req.body && req.body.network) {
    return req.body.network;
  }
  
  // Priority 3: Vendor address from params/body - get their network preference
  let vendorAddress = null;
  if (req.params && req.params.vendorAddress) {
    vendorAddress = req.params.vendorAddress;
  } else if (req.body && req.body.vendorAddress) {
    vendorAddress = req.body.vendorAddress;
  } else if (req.query && req.query.vendorAddress) {
    vendorAddress = req.query.vendorAddress;
  }
  
  if (vendorAddress) {
    try {
      const result = await pool.query(
        'SELECT network FROM vendor_profiles WHERE vendor_address = $1',
        [vendorAddress.toLowerCase()]
      );
      if (result.rows.length > 0 && result.rows[0].network) {
        return result.rows[0].network;
      }
    } catch (e) {
      console.warn('Could not fetch vendor network:', e.message);
    }
  }
  
  // Priority 4: Default to localhost
  return 'localhost';
}

/**
 * Get contract address for a network
 */
async function getContractAddressForNetwork(network) {
  try {
    const result = await pool.query(
      'SELECT contract_address FROM contract_deployments WHERE network = $1',
      [network]
    );
    
    if (result.rows.length > 0) {
      return result.rows[0].contract_address;
    }
  } catch (e) {
    console.warn('Could not fetch contract address from database:', e.message);
  }
  
  return null;
}

module.exports = {
  getNetworkFromRequest,
  getContractAddressForNetwork
};

