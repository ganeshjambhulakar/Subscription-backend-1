const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { ethers } = require('ethers');
const contractService = require('../services/contractService');
const { checkMaintenanceMode } = require('../middleware/maintenanceMode');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Apply maintenance mode middleware to all plan routes
router.use(checkMaintenanceMode('vendor'));

// Apply maintenance mode middleware to all plan routes
router.use(checkMaintenanceMode('vendor'));

/**
 * GET /api/plans
 * Get all subscription plans
 */
router.get('/', async (req, res, next) => {
  try {
    // Check database connection first
    try {
      await pool.query('SELECT 1');
    } catch (dbError) {
      console.error('[Plans] Database connection error:', dbError);
      return res.status(503).json({ 
        error: 'Database connection failed',
        message: 'Please ensure PostgreSQL is running and DATABASE_URL is configured correctly.'
      });
    }
    
    const result = await pool.query(
      'SELECT * FROM subscription_plans ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('[Plans] Error:', error);
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
 * GET /api/plans/:id
 * Get a specific plan by ID
 */
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM subscription_plans WHERE id = $1',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/plans/vendor/:vendorAddress
 * Get all plans for a specific vendor
 */
router.get('/vendor/:vendorAddress', async (req, res, next) => {
  try {
    const { vendorAddress } = req.params;
    const result = await pool.query(
      'SELECT * FROM subscription_plans WHERE vendor_address = $1 ORDER BY created_at DESC',
      [vendorAddress.toLowerCase()]
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/plans
 * Create a new subscription plan
 */
router.post('/', async (req, res, next) => {
  try {
    const { planId, name, description, price, duration, maxSubscriptions, vendorAddress, vendorPrivateKey, transactionHash, blockNumber, appId, network } = req.body;
    
    if (!name || !price || !duration || !vendorAddress) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    let finalPlanId = planId;
    
    // If we have a transaction hash, try to extract planId from the transaction receipt
    if ((!finalPlanId || finalPlanId === '0' || finalPlanId === null) && transactionHash) {
      console.log('🔍 Attempting to extract planId from transaction hash:', transactionHash);
      try {
        const provider = contractService.getProvider();
        const receipt = await provider.getTransactionReceipt(transactionHash);
        
        if (!receipt) {
          console.warn('⚠️ Transaction receipt not found for hash:', transactionHash);
        } else if (receipt.status !== 1) {
          console.warn('⚠️ Transaction failed. Status:', receipt.status);
        } else {
          console.log('✅ Transaction receipt found. Status: success');
          console.log('📋 Number of logs:', receipt.logs ? receipt.logs.length : 0);
          console.log('📋 Transaction to:', receipt.to);
          console.log('📋 Contract address:', (await contractService.getContract()).target);
          
          // Check if transaction was sent to the correct contract
          const contract = await contractService.getContract();
          const contractAddress = contract.target;
          
          if (receipt.to && receipt.to.toLowerCase() !== contractAddress.toLowerCase()) {
            console.error('❌ CRITICAL: Transaction was sent to wrong address!');
            console.error(`   Expected: ${contractAddress}`);
            console.error(`   Actual:   ${receipt.to}`);
            console.error('   This means the frontend is using the wrong contract address!');
          }
          
          // If no logs, the transaction might not have interacted with a contract
          if (!receipt.logs || receipt.logs.length === 0) {
            console.error('❌ CRITICAL: Transaction has 0 logs!');
            console.error('   This means:');
            console.error('   1. Transaction did not call a contract function');
            console.error('   2. Contract function failed silently');
            console.error('   3. Contract address is incorrect');
            console.error('   4. Transaction was a simple ETH transfer');
            
            // Try to get the transaction to see what it actually did
            try {
              const tx = await provider.getTransaction(transactionHash);
              console.error('   Transaction details:');
              console.error(`     To: ${tx.to}`);
              console.error(`     Data: ${tx.data.substring(0, 50)}...`);
              console.error(`     Value: ${tx.value.toString()}`);
            } catch (e) {
              console.error('   Could not fetch transaction details');
            }
          }
          
          // Try to parse events from the receipt
          let foundEvent = false;
          for (let i = 0; i < (receipt.logs ? receipt.logs.length : 0); i++) {
            const log = receipt.logs[i];
            try {
              console.log(`  Checking log ${i}: address=${log.address}, topics=${log.topics ? log.topics.length : 0}`);
              
              // Check if this log is from our contract
              const contractAddress = (await contractService.getContract()).target;
              if (log.address.toLowerCase() !== contractAddress.toLowerCase()) {
                console.log(`    Skipping log ${i}: not from our contract`);
                continue;
              }
              
              const parsed = contract.interface.parseLog(log);
              console.log(`    Parsed log ${i}: name=${parsed.name}, args=${parsed.args ? Object.keys(parsed.args).length : 0}`);
              
              if (parsed && parsed.name === 'PlanCreated' && parsed.args) {
                if (parsed.args.planId) {
                  finalPlanId = parsed.args.planId.toString();
                  console.log('✅✅✅ Found planId from transaction receipt:', finalPlanId);
                }
                // Extract appId from PlanCreated event (third indexed parameter)
                if (parsed.args.appId !== undefined) {
                  const eventAppId = parsed.args.appId.toString();
                  console.log('✅✅✅ Found appId from PlanCreated event:', eventAppId);
                  // Use appId from event if not provided in request body
                  if (!appId || appId === '0' || appId === null) {
                    appId = eventAppId;
                    console.log('✅ Using appId from PlanCreated event:', appId);
                  }
                }
                foundEvent = true;
                break;
              }
            } catch (e) {
              console.log(`    Failed to parse log ${i}:`, e.message);
              // Continue to next log
              continue;
            }
          }
          
          if (!foundEvent) {
            console.warn('⚠️ PlanCreated event not found in transaction logs');
            console.warn('⚠️ This might mean:');
            console.warn('   1. Event was not emitted');
            console.warn('   2. ABI does not match contract');
            console.warn('   3. Contract address mismatch');
          }
        }
      } catch (e) {
        console.error('❌ Error extracting planId from transaction hash:', e.message);
        console.error('❌ Stack:', e.stack);
      }
    }
    
    // If planId is not provided, null, or '0', we need to find it from the contract
    if (!finalPlanId || finalPlanId === '0' || finalPlanId === null) {
      console.log('PlanId not provided, attempting to find from contract...');
      console.log('Vendor address:', vendorAddress);
      console.log('Plan details:', { name, price, duration });
      
      try {
        const contract = await contractService.getContract();
        const provider = contractService.getProvider();
        
        // Normalize vendor address (checksum format)
        const normalizedVendorAddress = ethers.getAddress(vendorAddress);
        console.log('Normalized vendor address:', normalizedVendorAddress);
        
        // Wait a bit for blockchain state to update after transaction
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Get vendor plans - try multiple methods
        let vendorPlans = [];
        
        // Method 1: Try getVendorPlans function
        try {
          vendorPlans = await contract.getVendorPlans(normalizedVendorAddress);
          console.log('Vendor plans found (getVendorPlans):', vendorPlans ? vendorPlans.length : 0, vendorPlans);
        } catch (e) {
          console.warn('getVendorPlans failed:', e.message);
          
          // Method 2: Try with lowercase address
          try {
            vendorPlans = await contract.getVendorPlans(vendorAddress.toLowerCase());
            console.log('Vendor plans found (lowercase):', vendorPlans ? vendorPlans.length : 0);
          } catch (e2) {
            console.warn('getVendorPlans (lowercase) failed:', e2.message);
            
            // Method 3: Try accessing vendorPlans mapping directly
            try {
              // Try to read from mapping by index (0, 1, 2, etc.)
              vendorPlans = [];
              for (let i = 0; i < 100; i++) { // Check up to 100 plans
                try {
                  const planId = await contract['vendorPlans(address,uint256)'](normalizedVendorAddress, i);
                  if (planId && planId.toString() !== '0') {
                    vendorPlans.push(planId);
                  } else {
                    break; // No more plans
                  }
                } catch (e3) {
                  break; // Reached end of array
                }
              }
              console.log('Vendor plans found (mapping access):', vendorPlans.length);
            } catch (e3) {
              console.warn('Mapping access failed:', e3.message);
            }
          }
        }
        
        if (vendorPlans && vendorPlans.length > 0) {
          console.log('Searching through', vendorPlans.length, 'plans...');
          
          // Find the plan that matches our criteria
          for (let i = vendorPlans.length - 1; i >= 0; i--) {
            const checkPlanId = vendorPlans[i];
            try {
              const plan = await contract.getPlan(checkPlanId);
              const planPrice = ethers.formatEther(plan.price);
              const planDuration = parseInt(plan.duration.toString());
              
              console.log(`Checking plan ${i}:`, {
                planId: checkPlanId.toString(),
                name: plan.name,
                price: planPrice,
                duration: planDuration
              });
              
              // Match by name, price, and duration
              if (plan.name === name && 
                  Math.abs(parseFloat(planPrice) - parseFloat(price)) < 0.0001 &&
                  planDuration === parseInt(duration)) {
                finalPlanId = checkPlanId.toString();
                console.log('✅ Found matching planId:', finalPlanId);
                // Also extract appId from the plan if not already set
                if (plan.appId && (!appId || appId === '0' || appId === null)) {
                  appId = plan.appId.toString();
                  console.log('✅ Found appId from plan:', appId);
                }
                break;
              }
            } catch (e) {
              console.warn(`Error checking plan ${i}:`, e.message);
              continue;
            }
          }
          
          // If still not found, get the latest plan (most recently created)
          // This assumes the latest plan in the array is the one we just created
          if (!finalPlanId || finalPlanId === '0' || finalPlanId === null) {
            console.log('No exact match found, using latest plan in array');
            // Wait a bit more for state to update
            await new Promise(resolve => setTimeout(resolve, 1000));
            // Re-fetch to get latest state
            try {
              vendorPlans = await contract.getVendorPlans(normalizedVendorAddress);
            } catch (e) {
              try {
                vendorPlans = await contract.getVendorPlans(vendorAddress.toLowerCase());
              } catch (e2) {
                // Use existing vendorPlans
              }
            }
            
            if (vendorPlans && vendorPlans.length > 0) {
              finalPlanId = vendorPlans[vendorPlans.length - 1].toString();
              console.log('✅ Using latest planId from vendor plans:', finalPlanId);
            }
          }
        } else {
          console.warn('No vendor plans found for address:', normalizedVendorAddress);
        }
      } catch (error) {
        console.error('Error finding planId from contract:', error);
        console.error('Error stack:', error.stack);
        // Continue and let it fail gracefully with better error message
      }
    }
    
    if (!finalPlanId || finalPlanId === '0' || finalPlanId === null) {
      return res.status(400).json({ 
        error: 'Could not determine planId. The plan may not have been created on the blockchain, or the transaction may have failed. Please try creating the plan again.' 
      });
    }
    
    // CRITICAL: Validate planId exists on blockchain before saving to database
    console.log(`[Backend Plan Creation] 🔍 Validating planId ${finalPlanId} exists on blockchain...`);
    try {
      const contract = await contractService.getContract();
      if (!contract) {
        throw new Error('Contract not initialized');
      }
      
      // Verify transaction was sent to correct contract if we have transaction hash
      if (transactionHash) {
        try {
          const provider = contractService.getProvider();
          const receipt = await provider.getTransactionReceipt(transactionHash);
          const contractAddress = contract.target;
          
          if (receipt && receipt.to && receipt.to.toLowerCase() !== contractAddress.toLowerCase()) {
            console.error(`[Backend Plan Creation] ❌ Transaction sent to wrong contract!`);
            console.error(`   Expected: ${contractAddress}`);
            console.error(`   Actual:   ${receipt.to}`);
            return res.status(400).json({
              error: `Transaction was sent to the wrong contract address. This usually happens when the contract address changed. Please refresh the page and try again.`,
              planId: finalPlanId,
              expectedContract: contractAddress,
              actualContract: receipt.to,
              transactionHash: transactionHash
            });
          }
          
          // Check if transaction actually succeeded
          if (receipt && receipt.status !== 1) {
            console.error(`[Backend Plan Creation] ❌ Transaction failed! Status: ${receipt.status}`);
            return res.status(400).json({
              error: `The blockchain transaction failed. Please try creating the plan again.`,
              planId: finalPlanId,
              transactionHash: transactionHash,
              transactionStatus: receipt.status
            });
          }
        } catch (txError) {
          console.warn(`[Backend Plan Creation] ⚠️ Could not verify transaction: ${txError.message}`);
          // Continue with plan validation even if transaction check fails
        }
      }
      
      // Try to get plan from blockchain
      try {
        const blockchainPlan = await contract.getPlan(finalPlanId);
        
        // Verify plan is valid (not empty/default)
        if (!blockchainPlan || blockchainPlan.planId.toString() === '0') {
          console.error(`[Backend Plan Creation] ❌ Plan ${finalPlanId} does not exist on blockchain (planId is 0)`);
          
          // Provide helpful error message
          let errorMessage = `Plan ${finalPlanId} does not exist on blockchain.`;
          if (transactionHash) {
            errorMessage += ` The transaction may have failed or the planId was incorrectly extracted from the transaction receipt.`;
          } else {
            errorMessage += ` No transaction hash was provided, so the plan was never created on the blockchain.`;
          }
          
          return res.status(400).json({
            error: errorMessage,
            planId: finalPlanId,
            transactionHash: transactionHash || null,
            suggestion: 'Please try creating the plan again. If the issue persists, the contract address may have changed - try refreshing the page.'
          });
        }
        
        // Verify planId matches
        if (blockchainPlan.planId.toString() !== finalPlanId) {
          console.error(`[Backend Plan Creation] ❌ Plan ID mismatch! Expected: ${finalPlanId}, Got: ${blockchainPlan.planId.toString()}`);
          return res.status(400).json({
            error: `Plan ID mismatch. Expected ${finalPlanId} but got ${blockchainPlan.planId.toString()} from blockchain.`,
            planId: finalPlanId
          });
        }
        
        // Verify vendor matches
        if (blockchainPlan.vendor.toLowerCase() !== vendorAddress.toLowerCase()) {
          console.error(`[Backend Plan Creation] ❌ Vendor mismatch! Expected: ${vendorAddress}, Got: ${blockchainPlan.vendor}`);
          return res.status(400).json({
            error: `Plan vendor mismatch. Plan belongs to ${blockchainPlan.vendor} but request is from ${vendorAddress}.`,
            planId: finalPlanId
          });
        }
        
        console.log(`[Backend Plan Creation] ✅ Plan ${finalPlanId} verified on blockchain:`, {
          name: blockchainPlan.name,
          vendor: blockchainPlan.vendor,
          active: blockchainPlan.active,
          appId: blockchainPlan.appId?.toString()
        });
      } catch (blockchainError) {
        // BAD_DATA or other errors mean plan doesn't exist
        if (blockchainError.code === 'BAD_DATA' || 
            blockchainError.message?.includes('could not decode result') ||
            blockchainError.message?.includes('value="0x"')) {
          console.error(`[Backend Plan Creation] ❌ Plan ${finalPlanId} does not exist on blockchain (BAD_DATA error)`);
          return res.status(400).json({
            error: `Plan ${finalPlanId} does not exist on blockchain. The transaction may have failed or the planId is incorrect.`,
            planId: finalPlanId,
            transactionHash: transactionHash
          });
        }
        
        // Re-throw other errors
        throw blockchainError;
      }
    } catch (validationError) {
      console.error(`[Backend Plan Creation] ❌ Error validating plan on blockchain:`, validationError);
      return res.status(500).json({
        error: `Failed to validate plan on blockchain: ${validationError.message}`,
        planId: finalPlanId
      });
    }
    
    // Check if plan already exists in database
    const existingPlan = await pool.query(
      'SELECT * FROM subscription_plans WHERE plan_id = $1',
      [finalPlanId]
    );
    
    if (existingPlan.rows.length > 0) {
      // Plan already exists, return it
      console.log(`[Backend Plan Creation] ℹ️ Plan ${finalPlanId} already exists in database, returning existing record`);
      return res.json(existingPlan.rows[0]);
    }
    
    // If we still don't have a planId but transaction succeeded, 
    // we can still save it with a placeholder and let the user know
    if (!finalPlanId || finalPlanId === '0' || finalPlanId === null) {
      // Generate a temporary planId based on transaction hash
      if (transactionHash) {
        // Use first 16 chars of transaction hash as temporary ID
        finalPlanId = 'temp_' + transactionHash.substring(2, 18);
        console.warn('⚠️ Using temporary planId:', finalPlanId);
        console.warn('⚠️ Transaction hash:', transactionHash);
        console.warn('⚠️ The plan was likely created on blockchain but planId extraction failed.');
        console.warn('⚠️ Plan will be saved with temporary ID. User should verify on blockchain.');
      } else {
        console.error('❌ No transaction hash provided and planId not found');
        console.error('❌ This means either:');
        console.error('   1. Transaction failed on frontend');
        console.error('   2. Frontend did not send transaction hash');
        console.error('   3. Plan was not created on blockchain');
        return res.status(400).json({ 
          error: 'Could not determine planId. The plan may not have been created on the blockchain, or the transaction may have failed. Please try creating the plan again. If the transaction succeeded, check your plans list - it may have been created with a different ID.',
          debug: {
            planIdProvided: planId,
            transactionHashProvided: transactionHash ? 'Yes' : 'No',
            vendorAddress: vendorAddress
          }
        });
      }
    }
    
    // Get pause settings from request
    const pauseEnabled = req.body.pauseEnabled === true || req.body.pauseEnabled === 'true';
    const maxPauseAttempts = parseInt(req.body.maxPauseAttempts) || 0;
    
    // Get vendor's network preference if not provided
    let planNetwork = network;
    if (!planNetwork) {
      try {
        const vendorProfile = await pool.query(
          'SELECT network FROM vendor_profiles WHERE vendor_address = $1',
          [vendorAddress.toLowerCase()]
        );
        if (vendorProfile.rows.length > 0 && vendorProfile.rows[0].network) {
          planNetwork = vendorProfile.rows[0].network;
        } else {
          planNetwork = 'localhost'; // Default
        }
      } catch (e) {
        planNetwork = 'localhost'; // Default on error
      }
    }
    
    // Save to database
    const result = await pool.query(
      `INSERT INTO subscription_plans 
       (plan_id, vendor_address, name, description, price, duration, max_subscriptions, pause_enabled, max_pause_attempts, app_id, network, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
       ON CONFLICT (plan_id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         price = EXCLUDED.price,
         duration = EXCLUDED.duration,
         max_subscriptions = EXCLUDED.max_subscriptions,
         pause_enabled = EXCLUDED.pause_enabled,
         max_pause_attempts = EXCLUDED.max_pause_attempts,
         app_id = EXCLUDED.app_id,
         network = EXCLUDED.network
       RETURNING *`,
      [finalPlanId, vendorAddress.toLowerCase(), name, description, price, duration, maxSubscriptions || 0, pauseEnabled, maxPauseAttempts, appId || null, planNetwork]
    );
    
    res.status(201).json({
      ...result.rows[0],
      warning: finalPlanId.startsWith('temp_') ? 'Plan saved with temporary ID. Please verify the plan was created on the blockchain.' : undefined
    });
  } catch (error) {
    console.error('Error creating plan:', error);
    next(error);
  }
});

/**
 * PUT /api/plans/:id
 * Update a subscription plan (database only - blockchain data is immutable)
 */
router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, description, active, maxSubscriptions } = req.body;
    
    // First, verify the plan exists
    const planCheck = await pool.query(
      'SELECT * FROM subscription_plans WHERE id = $1',
      [id]
    );
    
    if (planCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(description);
    }
    if (active !== undefined) {
      updates.push(`active = $${paramCount++}`);
      values.push(active);
    }
    if (maxSubscriptions !== undefined) {
      updates.push(`max_subscriptions = $${paramCount++}`);
      values.push(maxSubscriptions);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    
    updates.push(`updated_at = NOW()`);
    values.push(id);
    
    const result = await pool.query(
      `UPDATE subscription_plans 
       SET ${updates.join(', ')}
       WHERE id = $${paramCount}
       RETURNING *`,
      values
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/plans/:id
 * Delete a subscription plan
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'DELETE FROM subscription_plans WHERE id = $1 RETURNING *',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    
    res.json({ message: 'Plan deleted successfully', plan: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

