const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * POST /api/subscriptions/:tokenId/renew
 * Record a renewal event in subscription history
 */
router.post('/:tokenId/renew', async (req, res, next) => {
  try {
    const { tokenId } = req.params;
    const { transactionHash, blockNumber } = req.body;
    
    // Get subscription details
    const subResult = await pool.query(
      'SELECT s.*, p.vendor_address, p.price FROM subscriptions s JOIN subscription_plans p ON s.plan_id = p.plan_id WHERE s.token_id = $1',
      [tokenId]
    );
    
    if (subResult.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }
    
    const sub = subResult.rows[0];
    
    // Record in history (using actual table structure: action, metadata)
    await pool.query(
      `INSERT INTO subscription_history 
       (token_id, action, metadata, transaction_hash, block_number)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        tokenId,
        'renewed',
        JSON.stringify({ 
          timestamp: new Date().toISOString(),
          price: sub.price || '0',
          plan_id: sub.plan_id,
          subscriber_address: sub.subscriber_address,
          vendor_address: sub.vendor_address
        }),
        transactionHash,
        blockNumber
      ]
    );
    
    res.json({ message: 'Renewal event recorded', tokenId });
  } catch (error) {
    console.error('Error recording renewal:', error);
    next(error);
  }
});

module.exports = router;

