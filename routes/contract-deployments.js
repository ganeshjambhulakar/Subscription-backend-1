const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * GET /api/contract-deployments
 * Get all contract deployments
 */
router.get('/', async (req, res, next) => {
  try {
    // Check database connection first
    try {
      await pool.query('SELECT 1');
    } catch (dbError) {
      console.error('[Contract Deployments] Database connection error:', dbError);
      return res.status(503).json({ 
        error: 'Database connection failed',
        message: 'Please ensure PostgreSQL is running and DATABASE_URL is configured correctly.'
      });
    }
    
    const result = await pool.query(
      'SELECT * FROM contract_deployments ORDER BY chain_id, contract_type, updated_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('[Contract Deployments] Error:', error);
    // Ensure response is sent even on error
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal server error',
        message: error.message
      });
    }
  }
});

/**
 * GET /api/contract-deployments/by-chain/:chainId
 * Get contract deployment for a specific chainId (and optional contractType)
 */
router.get('/by-chain/:chainId', async (req, res, next) => {
  try {
    const chainId = parseInt(req.params.chainId, 10);
    const contractType = (req.query.contractType || 'unified').toString();

    if (!Number.isFinite(chainId)) {
      return res.status(400).json({ error: 'Invalid chainId' });
    }

    // Check database connection first
    try {
      await pool.query('SELECT 1');
    } catch (dbError) {
      console.error('[Contract Deployments] Database connection error:', dbError);
      return res.status(503).json({
        error: 'Database connection failed',
        message: 'Please ensure PostgreSQL is running and DATABASE_URL is configured correctly.'
      });
    }

    const result = await pool.query(
      `SELECT *
       FROM contract_deployments
       WHERE chain_id = $1 AND contract_type = $2
       ORDER BY updated_at DESC
       LIMIT 1`,
      [chainId, contractType]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: `Contract not deployed for chainId: ${chainId} (${contractType})`,
        message: `Please deploy the contract for chainId ${chainId} first.`
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('[Contract Deployments] Error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal server error',
        message: error.message
      });
    }
  }
});

/**
 * GET /api/contract-deployments/:network
 * Get contract deployment for a specific network
 */
router.get('/:network', async (req, res, next) => {
  try {
    const { network } = req.params;
    const contractType = (req.query.contractType || 'unified').toString();
    
    // Check database connection first
    try {
      await pool.query('SELECT 1');
    } catch (dbError) {
      console.error('[Contract Deployments] Database connection error:', dbError);
      return res.status(503).json({ 
        error: 'Database connection failed',
        message: 'Please ensure PostgreSQL is running and DATABASE_URL is configured correctly.'
      });
    }
    
    const result = await pool.query(
      `SELECT *
       FROM contract_deployments
       WHERE network = $1 AND contract_type = $2
       ORDER BY updated_at DESC
       LIMIT 1`,
      [network, contractType]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        error: `Contract not deployed on network: ${network} (${contractType})`,
        message: `Please deploy the contract to ${network} first.`
      });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('[Contract Deployments] Error:', error);
    // Ensure response is sent even on error
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal server error',
        message: error.message
      });
    }
  }
});

/**
 * POST /api/contract-deployments
 * Register a new contract deployment
 */
router.post('/', async (req, res, next) => {
  try {
    const {
      network,
      chainId,
      contractType,
      contractAddress,
      rpcUrl,
      deployedVia,
      deployerAddress,
      deployer, // back-compat alias (some scripts use "deployer")
      transactionHash,
      blockNumber,
      abiJson,
      abiVersion
    } = req.body;
    
    const parsedChainId = parseInt(chainId, 10);
    const normalizedContractType = (contractType || 'unified').toString();
    const normalizedNetwork = (network || '').toString() || null;
    const normalizedDeployerAddress = (deployerAddress || deployer || null)?.toString() || null;

    if (!parsedChainId || !contractAddress) {
      return res.status(400).json({ 
        error: 'Missing required fields: chainId, contractAddress'
      });
    }
    
    const result = await pool.query(
      `INSERT INTO contract_deployments (
         network,
         chain_id,
         contract_type,
         contract_address,
         rpc_url,
         deployed_via,
         deployer_address,
         transaction_hash,
         block_number,
         abi_json,
         abi_version
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (chain_id, contract_type) DO UPDATE SET
         network = EXCLUDED.network,
         contract_address = EXCLUDED.contract_address,
         rpc_url = EXCLUDED.rpc_url,
         deployed_via = EXCLUDED.deployed_via,
         deployer_address = EXCLUDED.deployer_address,
         transaction_hash = EXCLUDED.transaction_hash,
         block_number = EXCLUDED.block_number,
         abi_json = EXCLUDED.abi_json,
         abi_version = EXCLUDED.abi_version,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        normalizedNetwork,
        parsedChainId,
        normalizedContractType,
        contractAddress,
        rpcUrl || null,
        deployedVia || 'unknown',
        normalizedDeployerAddress,
        transactionHash || null,
        blockNumber || null,
        abiJson || null,
        abiVersion || null
      ]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

module.exports = router;

