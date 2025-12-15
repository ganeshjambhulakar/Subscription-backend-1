const { Pool } = require('pg');
const contractService = require('./contractService');
const webhookService = require('./webhookService');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Check for expired subscriptions and trigger webhooks (AC2.8)
 */
async function checkExpiredSubscriptions(network = 'localhost') {
  try {
    const contract = await contractService.getContract(network);
    const now = Math.floor(Date.now() / 1000);

    // Get all active subscriptions from database
    const result = await pool.query(
      `SELECT s.*, sp.vendor_address, sp.name as plan_name
       FROM subscriptions s
       LEFT JOIN subscription_plans sp ON s.plan_id = sp.plan_id
       WHERE s.subscriber_address IS NOT NULL`
    );

    const expiredSubscriptions = [];

    for (const sub of result.rows) {
      try {
        // Get subscription from blockchain
        const blockchainSub = await contract.getSubscription(sub.token_id);
        const endTime = parseInt(blockchainSub.endTime.toString());
        const isActive = blockchainSub.active;
        
        // Check if expired (endTime < now) and was previously active
        if (endTime < now && isActive) {
          // Check if we've already sent expiry webhook (track in metadata or separate table)
          const expiryCheck = await pool.query(
            `SELECT metadata FROM subscriptions WHERE token_id = $1`,
            [sub.token_id]
          );
          
          const metadata = expiryCheck.rows[0]?.metadata ? JSON.parse(expiryCheck.rows[0].metadata) : {};
          
          // Only send webhook if not already sent
          if (!metadata.expiryWebhookSent) {
            expiredSubscriptions.push({
              tokenId: sub.token_id.toString(),
              planId: blockchainSub.planId.toString(),
              customerAddress: sub.subscriber_address.toLowerCase(),
              endTime: endTime,
              endTimeISO: new Date(endTime * 1000).toISOString(),
              daysSinceExpiry: Math.floor((now - endTime) / 86400),
              planName: sub.plan_name || 'Unknown Plan',
              vendorAddress: sub.vendor_address?.toLowerCase()
            });

            // Mark as webhook sent
            await pool.query(
              `UPDATE subscriptions 
               SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"expiryWebhookSent": true}'::jsonb
               WHERE token_id = $1`,
              [sub.token_id]
            );
          }
        }
      } catch (error) {
        console.warn(`[SubscriptionExpiry] Error checking subscription ${sub.token_id}:`, error.message);
      }
    }

    // Trigger webhooks for expired subscriptions
    for (const expiredSub of expiredSubscriptions) {
      try {
        // Find API key for vendor
        if (expiredSub.vendorAddress) {
          const apiKeyResult = await pool.query(
            `SELECT id FROM checkout_apps WHERE vendor_address = $1 AND status = 'active' LIMIT 1`,
            [expiredSub.vendorAddress]
          );

          if (apiKeyResult.rows.length > 0) {
            const payload = {
              tokenId: expiredSub.tokenId,
              planId: expiredSub.planId,
              customerAddress: expiredSub.customerAddress,
              endTime: expiredSub.endTime,
              endTimeISO: expiredSub.endTimeISO,
              expiryTimestamp: new Date().toISOString(),
              daysSinceExpiry: expiredSub.daysSinceExpiry,
              plan: {
                name: expiredSub.planName
              }
            };

            await webhookService.triggerWebhook(
              apiKeyResult.rows[0].id,
              'subscription.expired',
              payload
            );

            console.log(`[SubscriptionExpiry] ✅ Sent expiry webhook for subscription ${expiredSub.tokenId}`);
          }
        }
      } catch (webhookError) {
        console.error(`[SubscriptionExpiry] Error sending expiry webhook:`, webhookError.message);
      }
    }

    return expiredSubscriptions.length;
  } catch (error) {
    console.error('[SubscriptionExpiry] Error checking expired subscriptions:', error);
    return 0;
  }
}

/**
 * Start subscription expiry checker (runs every hour)
 */
function startExpiryChecker(network = 'localhost') {
  console.log('[SubscriptionExpiry] Starting subscription expiry checker...');
  
  // Run immediately
  checkExpiredSubscriptions(network).catch(console.error);

  // Then run every hour
  setInterval(() => {
    checkExpiredSubscriptions(network).catch(console.error);
  }, 3600000); // 1 hour
}

module.exports = {
  checkExpiredSubscriptions,
  startExpiryChecker
};


