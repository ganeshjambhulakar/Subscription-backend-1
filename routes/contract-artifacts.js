const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

function getUnifiedArtifactPath() {
  // Prefer local dev path where smart-contracts/ exists in the monorepo
  const localPath = path.join(
    __dirname,
    '../../smart-contracts/artifacts/contracts/SubscriptionAndCheckout.sol/SubscriptionAndCheckout.json'
  );
  if (fs.existsSync(localPath)) return localPath;

  // Fallback: allow running backend standalone with artifacts copied under backend/contracts
  const backendPath = path.join(
    __dirname,
    '../contracts/SubscriptionAndCheckout.sol/SubscriptionAndCheckout.json'
  );
  if (fs.existsSync(backendPath)) return backendPath;

  return null;
}

/**
 * GET /api/contract-artifacts/unified
 * Returns ABI + bytecode required for MetaMask/browser deployment
 */
router.get('/unified', async (req, res) => {
  try {
    const artifactPath = getUnifiedArtifactPath();
    if (!artifactPath) {
      return res.status(404).json({
        error: 'Artifact not found',
        message:
          'SubscriptionAndCheckout artifact not found. Ensure smart-contracts artifacts exist (run hardhat compile).'
      });
    }

    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    if (!artifact?.abi || !artifact?.bytecode) {
      return res.status(500).json({
        error: 'Invalid artifact',
        message: 'Artifact is missing abi and/or bytecode.'
      });
    }

    res.json({
      contractName: artifact.contractName || 'SubscriptionAndCheckout',
      abi: artifact.abi,
      bytecode: artifact.bytecode
    });
  } catch (error) {
    console.error('[Contract Artifacts] Error:', error);
    res.status(500).json({ error: 'Failed to load artifact', message: error.message });
  }
});

module.exports = router;


