const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { ethers } = require('ethers');
const contractService = require('../services/contractService');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * POST /api/subscriptions/:tokenId/publish
 * Toggle publish status of a subscription (vendor can control this)
 * Note: This requires the vendor's wallet to call the contract function
 */
router.post('/:tokenId/publish', async (req, res, next) => {
  try {
    const { tokenId } = req.params;
    const { published, vendorAddress } = req.body;
    
    if (published === undefined) {
      return res.status(400).json({ error: 'published parameter is required' });
    }
    
    // Get subscription details
    const subResult = await pool.query(
      `SELECT s.*, p.vendor_address 
       FROM subscriptions s 
       JOIN subscription_plans p ON s.plan_id = p.plan_id 
       WHERE s.token_id = $1`,
      [tokenId]
    );
    
    if (subResult.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }
    
    const sub = subResult.rows[0];
    
    // Verify that the vendor address matches
    if (vendorAddress && vendorAddress.toLowerCase() !== sub.vendor_address.toLowerCase()) {
      return res.status(403).json({ error: 'Vendor address does not match subscription vendor' });
    }
    
    // Get contract
    const contract = await contractService.getContract();
    const subscription = await contract.getSubscription(tokenId);
    
    // Check if already in desired state
    if (subscription.published === published) {
      return res.json({ 
        message: `Subscription is already ${published ? 'published' : 'hidden'}`,
        tokenId,
        published 
      });
    }
    
    // Note: The contract function setSubscriptionPublished requires the subscription owner (customer)
    // to call it. For vendors to control this, we would need to either:
    // 1. Modify the contract to allow vendors to control publish status for their subscriptions
    // 2. Use the customer's wallet (which we don't have access to in admin view)
    // 3. Store vendor wallets and use them (not recommended for security)
    
    // For now, we'll update the database and return a message
    // In a production system, you would need to modify the contract to allow vendor control
    await pool.query(
      'UPDATE subscriptions SET published = $1, updated_at = NOW() WHERE token_id = $2',
      [published, tokenId]
    );
    
    // Record in history
    await pool.query(
      `INSERT INTO subscription_history 
       (token_id, plan_id, subscriber_address, vendor_address, event_type, event_data, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        tokenId,
        sub.plan_id,
        sub.subscriber_address,
        sub.vendor_address,
        published ? 'published' : 'unpublished',
        JSON.stringify({ 
          timestamp: new Date().toISOString(),
          published: published,
          controlledBy: 'vendor'
        })
      ]
    );
    
    res.json({
      message: `Subscription ${published ? 'published' : 'hidden'} successfully`,
      tokenId,
      published,
      note: 'Database updated. Contract state requires customer wallet or contract modification for full blockchain control.'
    });
  } catch (error) {
    console.error('Error updating subscription publish status:', error);
    next(error);
  }
});

module.exports = router;

