const { Pool } = require('pg');
const contractService = require('./contractService');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Get comprehensive subscription data for a customer
 * Returns active subscriptions, history, plan details, and summary
 */
async function getCustomerSubscriptionData(customerAddress, network = 'localhost') {
  if (!customerAddress) {
    return {
      activeSubscriptions: [],
      subscriptionHistory: [],
      planDetails: [],
      summary: {
        totalSubscriptions: 0,
        activeCount: 0,
        nextExpiryDates: [],
        totalSubscriptionValue: '0'
      }
    };
  }

  const normalizedAddress = customerAddress.toLowerCase();
  const contract = await contractService.getContract(network);

  try {
    // Get all token IDs for this customer from blockchain
    const tokenIds = await contract.getUserSubscriptions(normalizedAddress);
    
    // Fetch subscription data from database
    const dbResult = await pool.query(
      `SELECT s.*, 
              sp.name as plan_name, 
              sp.description as plan_description,
              sp.price as plan_price, 
              sp.duration as plan_duration,
              sp.max_subscriptions,
              sp.pause_enabled,
              sp.max_pause_attempts,
              sp.app_id,
              a.name as app_name,
              a.description as app_description
       FROM subscriptions s
       LEFT JOIN subscription_plans sp ON s.plan_id = sp.plan_id
       LEFT JOIN apps a ON sp.app_id = a.app_id
       WHERE s.subscriber_address = $1
       ORDER BY s.created_at DESC`,
      [normalizedAddress]
    );

    const now = Math.floor(Date.now() / 1000);
    const activeSubscriptions = [];
    const subscriptionHistory = [];
    const planDetailsMap = new Map();
    let totalSubscriptionValue = BigInt(0);

    // Process subscriptions in parallel for better performance (AC8.2)
    const subscriptionPromises = dbResult.rows.map(async (dbSub) => {
      try {
        // Get blockchain data
        const blockchainSub = await contract.getSubscription(dbSub.token_id);
        const isValid = await contract.isSubscriptionValid(dbSub.token_id);
        
        const startTime = parseInt(blockchainSub.startTime.toString());
        const endTime = parseInt(blockchainSub.endTime.toString());
        const isActive = blockchainSub.active && isValid && endTime > now;
        const isExpired = endTime <= now;
        const isPaused = blockchainSub.paused || false;
        
        // Calculate remaining duration
        const remainingDuration = isActive ? (endTime - now) : 0;
        
        // Get plan details from blockchain if available
        let planDetails = null;
        try {
          const plan = await contract.getPlan(blockchainSub.planId.toString());
          planDetails = {
            planId: blockchainSub.planId.toString(),
            name: plan.name,
            description: plan.description,
            price: plan.price.toString(),
            duration: plan.duration.toString(),
            maxSubscriptions: plan.maxSubscriptions ? plan.maxSubscriptions.toString() : null,
            pauseEnabled: plan.pauseEnabled,
            maxPauseAttempts: plan.maxPauseAttempts ? plan.maxPauseAttempts.toString() : '0',
            appId: plan.appId ? plan.appId.toString() : null
          };
        } catch (e) {
          // Fallback to database plan data
          planDetails = {
            planId: dbSub.plan_id?.toString(),
            name: dbSub.plan_name || 'Unknown Plan',
            description: dbSub.plan_description || '',
            price: dbSub.plan_price?.toString() || '0',
            duration: dbSub.plan_duration?.toString() || '0',
            maxSubscriptions: dbSub.max_subscriptions?.toString() || null,
            pauseEnabled: dbSub.pause_enabled || false,
            maxPauseAttempts: dbSub.max_pause_attempts?.toString() || '0',
            appId: dbSub.app_id?.toString() || null,
            appName: dbSub.app_name || null,
            appDescription: dbSub.app_description || null
          };
        }

        // Store plan details
        if (planDetails.planId) {
          planDetailsMap.set(planDetails.planId, planDetails);
        }

        const subscriptionData = {
          tokenId: dbSub.token_id.toString(),
          planId: blockchainSub.planId.toString(),
          planName: planDetails.name,
          planDescription: planDetails.description,
          subscriberAddress: normalizedAddress,
          startTime: startTime,
          endTime: endTime,
          startTimeISO: new Date(startTime * 1000).toISOString(),
          endTimeISO: new Date(endTime * 1000).toISOString(),
          status: isExpired ? 'expired' : (isPaused ? 'paused' : (isActive ? 'active' : 'inactive')),
          active: isActive,
          paused: isPaused,
          isValid: isValid,
          remainingDuration: remainingDuration,
          remainingDurationDays: Math.floor(remainingDuration / 86400),
          pauseAttempts: blockchainSub.pauseAttempts ? parseInt(blockchainSub.pauseAttempts.toString()) : 0,
          published: blockchainSub.published !== undefined ? blockchainSub.published : true,
          transactionHash: dbSub.transaction_hash || null,
          createdAt: dbSub.created_at ? new Date(dbSub.created_at).toISOString() : null,
          planDetails: planDetails
        };
        
        return subscriptionData;
      } catch (error) {
        console.warn(`[SubscriptionData] Error processing subscription ${dbSub.token_id}:`, error.message);
        return null;
      }
    });
    
    // Wait for all subscriptions to be processed
    const processedSubscriptions = await Promise.all(subscriptionPromises);
    
    // Filter out null results and populate arrays
    for (const subData of processedSubscriptions) {
      if (!subData) continue;
      
      // Add to history
      subscriptionHistory.push(subData);
      
      // Add to active if active
      if (subData.active) {
        activeSubscriptions.push(subData);
      }
      
      // Store plan details
      if (subData.planDetails?.planId) {
        planDetailsMap.set(subData.planDetails.planId, subData.planDetails);
      }
      
      // Add to total value
      if (subData.planDetails?.price) {
        totalSubscriptionValue += BigInt(subData.planDetails.price);
      }
    }

    // Get subscription history from database (includes past subscriptions)
    const historyResult = await pool.query(
      `SELECT * FROM subscription_history 
       WHERE subscriber_address = $1
       ORDER BY created_at DESC`,
      [normalizedAddress]
    );

    // Add history entries that might not be in current subscriptions
    for (const historyEntry of historyResult.rows) {
      const exists = subscriptionHistory.find(s => s.tokenId === historyEntry.token_id?.toString());
      if (!exists && historyEntry.token_id) {
        try {
          const blockchainSub = await contract.getSubscription(historyEntry.token_id);
          subscriptionHistory.push({
            tokenId: historyEntry.token_id.toString(),
            planId: blockchainSub.planId.toString(),
            subscriberAddress: normalizedAddress,
            startTime: parseInt(blockchainSub.startTime.toString()),
            endTime: parseInt(blockchainSub.endTime.toString()),
            status: 'historical',
            transactionHash: historyEntry.transaction_hash || null,
            createdAt: historyEntry.created_at ? new Date(historyEntry.created_at).toISOString() : null,
            action: historyEntry.action || 'purchased'
          });
        } catch (e) {
          // Skip if can't fetch from blockchain
        }
      }
    }

    // Calculate summary
    const nextExpiryDates = activeSubscriptions
      .map(s => s.endTimeISO)
      .sort()
      .slice(0, 5); // Top 5 next expiries

    const summary = {
      totalSubscriptions: subscriptionHistory.length,
      activeCount: activeSubscriptions.length,
      expiredCount: subscriptionHistory.filter(s => s.status === 'expired').length,
      pausedCount: subscriptionHistory.filter(s => s.status === 'paused').length,
      nextExpiryDates: nextExpiryDates,
      totalSubscriptionValue: totalSubscriptionValue.toString(),
      customerAddress: normalizedAddress
    };

    return {
      activeSubscriptions,
      subscriptionHistory,
      planDetails: Array.from(planDetailsMap.values()),
      summary
    };
  } catch (error) {
    console.error('[SubscriptionData] Error fetching subscription data:', error);
    // Return empty data on error
    return {
      activeSubscriptions: [],
      subscriptionHistory: [],
      planDetails: [],
      summary: {
        totalSubscriptions: 0,
        activeCount: 0,
        expiredCount: 0,
        pausedCount: 0,
        nextExpiryDates: [],
        totalSubscriptionValue: '0',
        customerAddress: normalizedAddress
      },
      error: error.message
    };
  }
}

module.exports = {
  getCustomerSubscriptionData
};

