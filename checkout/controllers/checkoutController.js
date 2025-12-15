const checkoutService = require('../services/checkoutService');
const { Pool } = require('pg');
const checkoutContract = require('../helpers/contract');
const { ethers } = require('ethers');
const priceConversion = require('../services/priceConversion');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Register vendor for checkout
 */
async function registerVendor(req, res, next) {
  try {
    const { vendorAddress } = req.body;

    if (!vendorAddress) {
      return res.status(400).json({ error: 'Vendor address is required' });
    }

    const result = await checkoutService.registerVendor(vendorAddress, req.body);

    res.json({
      success: true,
      data: {
        vendorAddress: result.vendor_address,
        apiKey: result.api_key,
        apiSecret: result.api_secret, // Only on creation
        name: result.name,
        createdAt: result.created_at
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Generate API key for vendor
 */
async function generateApiKey(req, res, next) {
  try {
    const { vendorAddress } = req.params;

    if (!vendorAddress) {
      return res.status(400).json({ error: 'Vendor address is required' });
    }

    const result = await checkoutService.registerVendor(vendorAddress, {});

    res.json({
      success: true,
      data: {
        apiKey: result.api_key,
        apiSecret: result.api_secret,
        createdAt: result.created_at
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Set webhook URL
 */
async function setWebhookUrl(req, res, next) {
  try {
    const { vendorAddress } = req.params;
    const { webhookUrl } = req.body;

    if (!webhookUrl) {
      return res.status(400).json({ error: 'Webhook URL is required' });
    }

    const result = await pool.query(
      `UPDATE vendor_api_keys 
       SET webhook_url = $1, updated_at = CURRENT_TIMESTAMP
       WHERE vendor_address = $2 AND active = true
       RETURNING *`,
      [webhookUrl, vendorAddress.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Vendor API key not found' });
    }

    res.json({
      success: true,
      data: {
        webhookUrl: result.rows[0].webhook_url,
        updatedAt: result.rows[0].updated_at
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Set webhook URL using API key (AC5.1)
 * POST /api/checkout/webhook-url
 * Body: { webhookUrl: string }
 * Header: X-API-Key
 */
async function setWebhookUrlByApiKey(req, res, next) {
  try {
    const apiKey = req.headers['x-api-key'];
    const { webhookUrl } = req.body;

    if (!apiKey) {
      return res.status(401).json({ error: 'API key is required' });
    }

    if (!webhookUrl) {
      return res.status(400).json({ error: 'Webhook URL is required' });
    }

    // Find vendor by API key
    const result = await pool.query(
      `UPDATE vendor_api_keys 
       SET webhook_url = $1, updated_at = CURRENT_TIMESTAMP
       WHERE api_key = $2 AND active = true
       RETURNING *`,
      [webhookUrl, apiKey]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid API key or vendor not found' });
    }

    res.json({
      success: true,
      data: {
        webhookUrl: result.rows[0].webhook_url,
        updatedAt: result.rows[0].updated_at
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Create checkout order
 */
async function createOrder(req, res, next) {
  try {
    const {
      vendorAddress,
      customerAddress,
      items,
      totalAmount,
      totalAmountInINR, // For crypto payments, store INR equivalent
      currency = 'ETH',
      paymentMethod, // 'inr' or 'crypto' - if not provided, infer from currency
      cryptoCoin, // ETH, USDT, MATIC
      network = 'localhost',
      metadata = {}
    } = req.body;

    // Infer payment method if not provided
    // If currency is INR, default to 'inr', otherwise default to 'crypto'
    const inferredPaymentMethod = paymentMethod || (currency === 'INR' ? 'inr' : 'crypto');
    const finalPaymentMethod = inferredPaymentMethod;
    
    // Infer cryptoCoin from currency if not provided (for crypto payments)
    let finalCryptoCoin = null;
    if (finalPaymentMethod === 'crypto') {
      const inferredCryptoCoin = cryptoCoin || currency;
      if (!inferredCryptoCoin || !['ETH', 'USDT', 'MATIC'].includes(inferredCryptoCoin.toUpperCase())) {
        return res.status(400).json({ error: 'Invalid crypto coin. Must be ETH, USDT, or MATIC' });
      }
      finalCryptoCoin = inferredCryptoCoin.toUpperCase();
    }

    // Validation
    if (!vendorAddress) {
      return res.status(400).json({ error: 'Vendor address is required' });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Items array is required' });
    }

    if (!totalAmount || totalAmount <= 0) {
      return res.status(400).json({ error: 'Valid total amount is required' });
    }

    // Validate payment method
    if (!['inr', 'crypto'].includes(finalPaymentMethod)) {
      return res.status(400).json({ error: 'Invalid payment method. Must be "inr" or "crypto"' });
    }

    // For crypto payments, validate totalAmountInINR (optional but recommended)
    if (finalPaymentMethod === 'crypto') {
      if (!totalAmountInINR) {
        return res.status(400).json({ error: 'totalAmountInINR is required for crypto payments' });
      }
      if (totalAmountInINR && totalAmountInINR <= 0) {
        return res.status(400).json({ error: 'totalAmountInINR must be greater than 0 if provided' });
      }
    }

    // Verify API key if provided (optional for development)
    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
      const apiKeyData = await checkoutService.verifyApiKey(apiKey);
      if (!apiKeyData) {
        return res.status(401).json({ 
          error: 'Invalid API key',
          message: 'The provided API key does not exist or has been revoked. Please generate a new API key or remove the X-API-Key header to proceed without authentication.'
        });
      }
      if (apiKeyData.vendor_address.toLowerCase() !== vendorAddress.toLowerCase()) {
        return res.status(401).json({ 
          error: 'Invalid API key',
          message: `API key does not match vendor address. API key belongs to ${apiKeyData.vendor_address}, but order is for ${vendorAddress}.`
        });
      }
      // API key is valid and matches vendor - proceed
    } else {
      // No API key provided - allow in development, warn in production
      if (process.env.NODE_ENV === 'production') {
        console.warn(`[Checkout] Order created without API key for vendor ${vendorAddress} in production`);
      } else {
        console.log(`[Checkout] Order created without API key for vendor ${vendorAddress} (development mode)`);
      }
    }

    // Add payment method info to metadata
    const enhancedMetadata = {
      ...metadata,
      paymentMethod: finalPaymentMethod,
      ...(finalPaymentMethod === 'crypto' && {
        cryptoCoin: finalCryptoCoin,
        ...(totalAmountInINR && { totalAmountInINR })
      })
    };

    const order = await checkoutService.createOrder({
      vendorAddress,
      customerAddress,
      items,
      totalAmount,
      totalAmountInINR: totalAmountInINR, // Required for crypto payments; stored in metadata
      currency: finalPaymentMethod === 'inr' ? 'INR' : (finalPaymentMethod === 'crypto' ? finalCryptoCoin : currency),
      network,
      metadata: enhancedMetadata
    });

    // If crypto payment, create blockchain order
    if (finalPaymentMethod === 'crypto') {
      try {
        // Order will be created on blockchain when payment is processed
        // Frontend will handle the blockchain transaction
      } catch (blockchainError) {
        console.warn('[Checkout] Blockchain order creation will happen on payment:', blockchainError.message);
      }
    }

    res.status(201).json({
      success: true,
      data: order
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Create blockchain order (for existing database order)
 */
async function createBlockchainOrder(req, res, next) {
  try {
    const { orderId, network = 'localhost' } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: 'Order ID is required' });
    }

    // Get order with blockchain status sync (blockchain is source of truth)
    const order = await checkoutService.getOrder(orderId, network);
    if (!order) {
      return res.status(404).json({ error: 'Order not found in database' });
    }

    // Check if order already exists on blockchain
    try {
      const contract = await checkoutContract.getContract(network);
      const orderIdBytes = ethers.id(orderId);
      const exists = await contract.orderExists(orderIdBytes);
      
      if (exists) {
        return res.json({
          success: true,
          message: 'Order already exists on blockchain',
          data: { orderId, exists: true }
        });
      }

      // Create order on blockchain (requires owner private key)
      const ownerPrivateKey = process.env.CHECKOUT_CONTRACT_OWNER_PRIVATE_KEY;
      if (!ownerPrivateKey) {
        return res.status(400).json({ 
          error: 'CHECKOUT_CONTRACT_OWNER_PRIVATE_KEY not set. Cannot create order on blockchain.',
          message: 'Please set CHECKOUT_CONTRACT_OWNER_PRIVATE_KEY environment variable to enable blockchain order creation.'
        });
      }

      const rpcUrl = checkoutContract.getRpcUrlForNetwork(network);
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(ownerPrivateKey, provider);
      
      const config = checkoutContract.loadCheckoutConfig(network);
      const abi = checkoutContract.loadContractABI();
      const contractWithSigner = new ethers.Contract(config.contractAddress, abi, wallet);
      
      const amountWei = ethers.parseEther(order.total_amount.toString());
      const expiresAt = Math.floor(new Date(order.expires_at).getTime() / 1000);

      const tx = await contractWithSigner.createOrder(
        orderIdBytes,
        order.vendor_address,
        amountWei,
        expiresAt
      );

      const receipt = await tx.wait();

      res.json({
        success: true,
        data: {
          orderId,
          transactionHash: receipt.hash,
          blockNumber: receipt.blockNumber
        }
      });
    } catch (error) {
      console.error('[Checkout] Error creating blockchain order:', error);
      
      // Provide more detailed error messages
      let errorMessage = error.message || 'Failed to create order on blockchain';
      let statusCode = 500;
      
      if (error.message.includes('insufficient funds')) {
        errorMessage = 'Insufficient funds in contract owner account to pay for gas';
        statusCode = 402;
      } else if (error.message.includes('nonce')) {
        errorMessage = 'Transaction nonce error. Please try again in a moment.';
        statusCode = 429;
      } else if (error.message.includes('network') || error.message.includes('connection')) {
        errorMessage = 'Cannot connect to blockchain network. Please ensure Ganache is running.';
        statusCode = 503;
      } else if (error.message.includes('revert') || error.message.includes('execution reverted')) {
        errorMessage = `Smart contract error: ${error.message}`;
        statusCode = 400;
      }
      
      return res.status(statusCode).json({ 
        error: 'Failed to create order on blockchain',
        message: errorMessage,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  } catch (error) {
    next(error);
  }
}

/**
 * Get order by ID
 */
async function getOrder(req, res, next) {
  try {
    const { id } = req.params;
    const { network = 'localhost' } = req.query;

    // Get order with blockchain status sync (blockchain is source of truth)
    const order = await checkoutService.getOrder(id, network);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({
      success: true,
      data: order
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get customer orders (returns all orders)
 */
async function getCustomerOrders(req, res, next) {
  try {
    const { customerAddress } = req.params;
    const { network = 'localhost' } = req.query;

    // Return all orders regardless of customer address
    const orders = await checkoutService.getAllOrders(network);

    res.json({
      success: true,
      data: orders
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get vendor orders (returns all orders)
 */
async function getVendorOrders(req, res, next) {
  try {
    const { vendorAddress } = req.params;
    const { network = 'localhost' } = req.query;

    // Return all orders regardless of vendor address
    const orders = await checkoutService.getAllOrders(network);

    res.json({
      success: true,
      data: orders
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Update order status
 */
async function updateOrderStatus(req, res, next) {
  try {
    const { id } = req.params;
    const { status, network = 'localhost' } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    // Validate status
    const validStatuses = ['pending', 'paid', 'confirmed', 'received', 'cancelled', 'refunded'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ 
        error: 'Invalid status',
        message: `Status must be one of: ${validStatuses.join(', ')}`
      });
    }

    // Get current order (with blockchain status sync)
    const order = await checkoutService.getOrder(id, network);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Check if user is authorized to update this order
    const { userAddress, userType } = req.body; // userType: 'vendor' or 'customer'
    
    // Validate user authorization
    if (userType === 'customer') {
      // Customers can only update their own orders
      if (!userAddress || order.customer_address?.toLowerCase() !== userAddress.toLowerCase()) {
        return res.status(403).json({ error: 'Unauthorized: You can only update your own orders' });
      }
      // Customers can accept orders (paid -> confirmed), mark as received (confirmed -> received), or cancel orders
      if (status === 'confirmed' && order.status === 'paid') {
        // Customer accepting order - will release funds to vendor
      } else if (status === 'received' && order.status === 'confirmed') {
        // Customer marking as received
      } else if (status === 'cancelled') {
        // Customer cancelling order - allowed at any time (pending, paid, confirmed)
        if (!['pending', 'paid', 'confirmed'].includes(order.status)) {
          return res.status(400).json({ 
            error: 'Invalid status transition for customer',
            message: 'Customers can only cancel pending, paid, or confirmed orders'
          });
        }
      } else {
        return res.status(400).json({ 
          error: 'Invalid status transition for customer',
          message: 'Customers can accept paid orders, mark confirmed orders as received, or cancel orders'
        });
      }
    } else if (userType === 'vendor') {
      // Vendors can only update their own orders
      if (!userAddress || order.vendor_address?.toLowerCase() !== userAddress.toLowerCase()) {
        return res.status(403).json({ error: 'Unauthorized: You can only update your own vendor orders' });
      }
    } else {
      // Admin/system updates (no userType) - allow all transitions
    }

    // Validate status transition
    const validTransitions = {
      pending: ['paid', 'cancelled'],
      paid: ['confirmed', 'refunded', 'cancelled'], // Customers can cancel paid orders
      confirmed: ['received', 'refunded', 'cancelled'], // Customers can cancel confirmed orders
      received: [], // Once received, no further transitions
      cancelled: [],
      refunded: []
    };

    if (!validTransitions[order.status]?.includes(status)) {
      return res.status(400).json({
        error: 'Invalid status transition',
        message: `Cannot change status from ${order.status} to ${status}. Valid transitions: ${validTransitions[order.status]?.join(', ') || 'none'}`
      });
    }

    // Map database status to blockchain status enum
    const statusMap = {
      'pending': 0,    // OrderStatus.Pending
      'paid': 1,       // OrderStatus.Paid
      'confirmed': 2,   // OrderStatus.Confirmed
      'received': 3,   // OrderStatus.Received
      'cancelled': 4,  // OrderStatus.Cancelled
      'refunded': 5    // OrderStatus.Refunded
    };

    // CRITICAL: Blockchain is source of truth - update blockchain FIRST
    let blockchainTxHash = null;
    let orderExistsOnBlockchain = false;
    try {
      const contract = await checkoutContract.getContract(network);
      const orderIdBytes = ethers.id(id);
      orderExistsOnBlockchain = await contract.orderExists(orderIdBytes);
      
      // For cancellation, allow DB-only cancellation if order doesn't exist on blockchain
      if (!orderExistsOnBlockchain && status === 'cancelled') {
        // Order doesn't exist on blockchain - allow DB-only cancellation
        console.log(`[Checkout] Order ${id} does not exist on blockchain, allowing DB-only cancellation`);
        await checkoutService.updateOrderStatus(id, status);
        return res.json({
          success: true,
          message: 'Order cancelled in database (order was not on blockchain)',
          blockchainUpdated: false
        });
      }
      
      // For other status updates, require blockchain existence
      if (!orderExistsOnBlockchain) {
        return res.status(400).json({ 
          error: 'Order does not exist on blockchain',
          message: 'Cannot update status. Order must exist on blockchain first. Please create the order on blockchain.'
        });
      }

      // For customer cancellation, they need to sign the transaction themselves
      // Return instruction to call customerCancelOrder on frontend
      if (status === 'cancelled' && userType === 'customer') {
        return res.status(200).json({
          success: true,
          requiresCustomerSignature: true,
          message: 'Customer cancellation requires wallet signature. Please call customerCancelOrder on the contract.',
          orderId: id,
          network,
          action: 'customerCancelOrder'
        });
      }

      const ownerPrivateKey = process.env.CHECKOUT_CONTRACT_OWNER_PRIVATE_KEY;
      if (!ownerPrivateKey) {
        return res.status(500).json({ 
          error: 'CHECKOUT_CONTRACT_OWNER_PRIVATE_KEY not set',
          message: 'Cannot update order status on blockchain. Please configure the owner private key.'
        });
      }

      const rpcUrl = checkoutContract.getRpcUrlForNetwork(network);
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(ownerPrivateKey, provider);
      const config = checkoutContract.loadCheckoutConfig(network);
      const abi = checkoutContract.loadContractABI();
      const contractWithSigner = new ethers.Contract(config.contractAddress, abi, wallet);

      let tx;
      // Handle special cases with appropriate contract functions
      if (status === 'confirmed' && order.status === 'paid' && userType === 'customer') {
        // Customer accepts order - use acceptOrder (releases funds to vendor)
        tx = await contractWithSigner.acceptOrder(orderIdBytes);
        await tx.wait();
        blockchainTxHash = tx.hash;
        console.log(`[Checkout] ✅ Order ${id} accepted by customer, funds released to vendor on blockchain (tx: ${tx.hash})`);
      } else if (status === 'received' && userType === 'customer') {
        // Customer marks as received - requires customer signature
        // Return instruction to call markOrderReceived on frontend
        return res.status(200).json({
          success: true,
          requiresCustomerSignature: true,
          message: 'Marking order as received requires customer wallet signature. Please call markOrderReceived on the contract.',
          orderId: id,
          network,
          action: 'markOrderReceived'
        });
      } else if (status === 'confirmed' && order.status === 'paid' && userType === 'vendor') {
        // Vendor confirms order - use confirmOrder
        tx = await contractWithSigner.confirmOrder(orderIdBytes);
        await tx.wait();
        blockchainTxHash = tx.hash;
        console.log(`[Checkout] ✅ Order ${id} confirmed by vendor on blockchain (tx: ${tx.hash})`);
      } else if (status === 'cancelled' && order.status === 'pending') {
        // Cancel order - use cancelOrder
        tx = await contractWithSigner.cancelOrder(orderIdBytes);
        await tx.wait();
        blockchainTxHash = tx.hash;
        console.log(`[Checkout] ✅ Order ${id} cancelled on blockchain (tx: ${tx.hash})`);
      } else if (status === 'refunded' && (order.status === 'paid' || order.status === 'confirmed')) {
        // Refund order - use refundOrder
        tx = await contractWithSigner.refundOrder(orderIdBytes);
        await tx.wait();
        blockchainTxHash = tx.hash;
        console.log(`[Checkout] ✅ Order ${id} refunded on blockchain (tx: ${tx.hash})`);
      } else if (statusMap[status] !== undefined) {
        // Use generic updateOrderStatus for other cases (vendor/owner updates)
        tx = await contractWithSigner.updateOrderStatus(orderIdBytes, statusMap[status]);
        await tx.wait();
        blockchainTxHash = tx.hash;
        console.log(`[Checkout] ✅ Order ${id} status updated to ${status} on blockchain (tx: ${tx.hash})`);
      } else {
        return res.status(400).json({ 
          error: 'Invalid status',
          message: `Status ${status} is not valid for blockchain update`
        });
      }

      // Verify the status was updated on blockchain (blockchain is source of truth)
      const updatedBlockchainOrder = await contract.getOrder(orderIdBytes);
      const statusMapReverse = ['pending', 'paid', 'confirmed', 'received', 'cancelled', 'refunded'];
      const blockchainStatus = statusMapReverse[updatedBlockchainOrder.status];
      console.log(`[Checkout] ✅ Verified: Order ${id} status on blockchain is now: ${blockchainStatus}`);

      // Use blockchain status (not the requested status) to ensure consistency
      const finalStatus = blockchainStatus;

      // Update status in database AFTER successful blockchain update (sync with blockchain)
      const updatedOrder = await checkoutService.updateOrderStatus(id, finalStatus, blockchainTxHash);

      res.json({
        success: true,
        data: updatedOrder,
        transactionHash: blockchainTxHash,
        blockchainStatus: blockchainStatus,
        message: `Order status updated to ${finalStatus} on blockchain and synced to database`
      });

    } catch (blockchainError) {
      console.error(`[Checkout] ❌ Failed to update order status on blockchain:`, blockchainError);
      
      // For cancellation, allow DB-only update if blockchain update fails
      if (status === 'cancelled') {
        console.log(`[Checkout] ⚠️  Blockchain update failed for cancellation, allowing DB-only cancellation`);
        try {
          await checkoutService.updateOrderStatus(id, status);
          return res.json({
            success: true,
            message: 'Order cancelled in database (blockchain update failed)',
            blockchainUpdated: false,
            error: blockchainError.message
          });
        } catch (dbError) {
          console.error(`[Checkout] ❌ Failed to update database:`, dbError);
          return res.status(500).json({
            error: 'Failed to cancel order',
            message: 'Both blockchain and database updates failed',
            blockchainError: blockchainError.message,
            databaseError: dbError.message
          });
        }
      }
      
      // For other status updates, don't update database if blockchain fails (blockchain is source of truth)
      return res.status(500).json({ 
        error: 'Failed to update order status on blockchain',
        message: blockchainError.message || 'Blockchain transaction failed. Status not updated.',
        details: blockchainError.reason || blockchainError.error?.message
      });
    }
  } catch (error) {
    next(error);
  }
}

/**
 * Confirm payment
 */
async function confirmPayment(req, res, next) {
  try {
    const { orderId, transactionHash, network = 'localhost' } = req.body;

    if (!orderId || !transactionHash) {
      return res.status(400).json({ error: 'Order ID and transaction hash are required' });
    }

    // Get order with blockchain status sync (blockchain is source of truth)
    const order = await checkoutService.getOrder(orderId, network);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Verify transaction on blockchain
    try {
      const contract = await checkoutContract.getContract(network);
      const provider = contract.runner.provider;
      const receipt = await provider.getTransactionReceipt(transactionHash);

      if (!receipt || receipt.status !== 1) {
        return res.status(400).json({ error: 'Invalid transaction' });
      }

      // Verify payment event was emitted
      const orderIdBytes = ethers.id(orderId);
      const paymentEvent = receipt.logs.find(log => {
        try {
          const parsed = contract.interface.parseLog(log);
          return parsed && parsed.name === 'PaymentReceived' && parsed.args.orderId === orderIdBytes;
        } catch (e) {
          return false;
        }
      });

      if (!paymentEvent) {
        console.warn(`[Checkout] PaymentReceived event not found for order ${orderId}`);
      }

      // Record transaction
      await checkoutService.recordTransaction({
        orderId,
        transactionHash,
        fromAddress: receipt.from,
        toAddress: receipt.to,
        amount: order.total_amount,
        gasUsed: receipt.gasUsed.toString(),
        gasPrice: receipt.gasPrice ? receipt.gasPrice.toString() : null,
        blockNumber: receipt.blockNumber,
        network,
        status: 'confirmed'
      });

      // Update order status (blockchain already updated via processPayment)
      // Verify blockchain status matches
      try {
        const contract = await checkoutContract.getContract(network);
        const orderIdBytes = ethers.id(orderId);
        const blockchainOrder = await contract.getOrder(orderIdBytes);
        const statusMap = ['pending', 'paid', 'confirmed', 'received', 'cancelled', 'refunded'];
        const blockchainStatus = statusMap[blockchainOrder.status];
        
        if (blockchainStatus !== 'paid') {
          console.warn(`[Checkout] ⚠️ Blockchain status (${blockchainStatus}) does not match expected 'paid'`);
        }
      } catch (verifyError) {
        console.warn(`[Checkout] ⚠️ Could not verify blockchain status:`, verifyError.message);
      }

      await checkoutService.updateOrderStatus(orderId, 'paid', transactionHash);

      // Send webhooks
      const apiKeyResult = await pool.query(
        `SELECT id FROM vendor_api_keys WHERE vendor_address = $1 AND active = true LIMIT 1`,
        [order.vendor_address]
      );

      if (apiKeyResult.rows.length > 0) {
        // Send payment.completed webhook (AC2.2)
        await checkoutService.sendWebhook({
          vendorAddress: order.vendor_address,
          apiKeyId: apiKeyResult.rows[0].id,
          orderId,
          eventType: 'payment.completed',
          payload: {
            orderId,
            transactionHash,
            amount: order.total_amount,
            currency: order.currency,
            customerAddress: receipt.from,
            vendorAddress: order.vendor_address,
            network: network,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
            paymentTimestamp: new Date().toISOString()
          }
        });
      }

      res.json({
        success: true,
        data: {
          orderId,
          status: 'paid',
          transactionHash
        }
      });
    } catch (error) {
      console.error('[Checkout] Error confirming payment:', error);
      return res.status(500).json({ error: 'Failed to confirm payment', details: error.message });
    }
  } catch (error) {
    next(error);
  }
}

/**
 * Cancel payment/order
 * Supports both vendor cancellation (pending orders) and customer cancellation (any status)
 */
async function cancelPayment(req, res, next) {
  try {
    const { orderId, userAddress, userType, network = 'localhost' } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: 'Order ID is required' });
    }
    
    // Get order with blockchain status sync (blockchain is source of truth)
    const order = await checkoutService.getOrder(orderId, network);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Check authorization
    if (userType === 'customer') {
      // Customer can cancel their own orders at any time (pending, paid, confirmed)
      if (!userAddress || order.customer_address?.toLowerCase() !== userAddress.toLowerCase()) {
        return res.status(403).json({ error: 'Unauthorized: You can only cancel your own orders' });
      }
      if (!['pending', 'paid', 'confirmed'].includes(order.status)) {
        return res.status(400).json({ error: 'Order cannot be cancelled at this stage' });
      }
      // Customer cancellation requires wallet signature - return instruction
      return res.json({
        success: true,
        requiresCustomerSignature: true,
        message: 'Please sign the cancellation transaction in your wallet',
        orderId,
        network
      });
    } else {
      // Vendor/Owner can only cancel pending orders
      if (order.status !== 'pending') {
        return res.status(400).json({ error: 'Only pending orders can be cancelled by vendor' });
      }
    }

    // Update blockchain first (blockchain is source of truth) - for vendor/owner cancellation
    try {
      const contract = await checkoutContract.getContract(network);
      const orderIdBytes = ethers.id(orderId);
      const exists = await contract.orderExists(orderIdBytes);
      
      if (exists) {
        const ownerPrivateKey = process.env.CHECKOUT_CONTRACT_OWNER_PRIVATE_KEY;
        if (ownerPrivateKey) {
          const rpcUrl = checkoutContract.getRpcUrlForNetwork(network);
          const provider = new ethers.JsonRpcProvider(rpcUrl);
          const wallet = new ethers.Wallet(ownerPrivateKey, provider);
          const config = checkoutContract.loadCheckoutConfig(network);
          const abi = checkoutContract.loadContractABI();
          const contractWithSigner = new ethers.Contract(config.contractAddress, abi, wallet);

          const tx = await contractWithSigner.cancelOrder(orderIdBytes);
          await tx.wait();
          console.log(`[Checkout] ✅ Order ${orderId} cancelled on blockchain (tx: ${tx.hash})`);
          
          // Sync database with blockchain
          await checkoutService.updateOrderStatus(orderId, 'cancelled', tx.hash);
        } else {
          return res.status(500).json({ error: 'CHECKOUT_CONTRACT_OWNER_PRIVATE_KEY not set' });
        }
      } else {
        // Order doesn't exist on blockchain, just update database
        await checkoutService.updateOrderStatus(orderId, 'cancelled');
      }
    } catch (blockchainError) {
      console.error(`[Checkout] ❌ Failed to cancel order on blockchain:`, blockchainError);
      // Still update database even if blockchain update fails
      await checkoutService.updateOrderStatus(orderId, 'cancelled');
    }

    // Trigger order.cancelled webhook (AC2.6)
    try {
      const apiKeyResult = await pool.query(
        `SELECT id FROM vendor_api_keys WHERE vendor_address = $1 AND active = true LIMIT 1`,
        [order.vendor_address]
      );

      if (apiKeyResult.rows.length > 0) {
        await checkoutService.sendWebhook({
          vendorAddress: order.vendor_address,
          apiKeyId: apiKeyResult.rows[0].id,
          orderId,
          eventType: 'order.cancelled',
          payload: {
            orderId,
            vendorAddress: order.vendor_address,
            customerAddress: order.customer_address,
            totalAmount: order.total_amount,
            currency: order.currency,
            cancelledBy: userType || 'system',
            cancelledAt: new Date().toISOString(),
            previousStatus: order.status
          }
        });
      }
    } catch (webhookError) {
      console.warn('[Checkout] Error triggering order.cancelled webhook:', webhookError.message);
    }

    res.json({
      success: true,
      data: {
        orderId,
        status: 'cancelled'
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Process refund
 */
async function processRefund(req, res, next) {
  try {
    const { orderId } = req.body;
    const vendorAddress = req.body.vendorAddress || req.headers['x-vendor-address'];

    if (!orderId || !vendorAddress) {
      return res.status(400).json({ error: 'Order ID and vendor address are required' });
    }

    const order = await checkoutService.processRefund(orderId, vendorAddress);

    res.json({
      success: true,
      data: {
        orderId,
        status: 'refunded',
        amount: order.total_amount
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Accept order (customer accepts and releases payment to vendor)
 */
async function acceptOrder(req, res, next) {
  try {
    const { id } = req.params;
    const { customerAddress, network = 'localhost' } = req.body;

    if (!customerAddress) {
      return res.status(400).json({ error: 'Customer address is required' });
    }

    // Get order with blockchain status sync (blockchain is source of truth)
    const order = await checkoutService.getOrder(id, network);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Verify customer is authorized
    if (order.customer_address?.toLowerCase() !== customerAddress.toLowerCase()) {
      return res.status(403).json({ error: 'Unauthorized: You can only accept your own orders' });
    }

    // Verify order is in paid status
    if (order.status !== 'paid') {
      return res.status(400).json({ 
        error: 'Invalid order status',
        message: `Order must be paid to accept. Current status: ${order.status}`
      });
    }

    // Update status on blockchain
    try {
      const contract = await checkoutContract.getContract(network);
      const orderIdBytes = ethers.id(id);
      const exists = await contract.orderExists(orderIdBytes);
      
      if (exists) {
        // Get customer's wallet signer (this should be called from frontend with customer's wallet)
        // For now, we'll use the owner key as a fallback, but ideally customer should sign
        const ownerPrivateKey = process.env.CHECKOUT_CONTRACT_OWNER_PRIVATE_KEY;
        if (ownerPrivateKey) {
          const rpcUrl = checkoutContract.getRpcUrlForNetwork(network);
          const provider = new ethers.JsonRpcProvider(rpcUrl);
          const wallet = new ethers.Wallet(ownerPrivateKey, provider);
          const config = checkoutContract.loadCheckoutConfig(network);
          const abi = checkoutContract.loadContractABI();
          const contractWithSigner = new ethers.Contract(config.contractAddress, abi, wallet);

          // Call acceptOrder on blockchain
          const tx = await contractWithSigner.acceptOrder(orderIdBytes);
          await tx.wait();
          console.log(`[Checkout] ✅ Order ${id} accepted by customer, funds released to vendor on blockchain`);
        } else {
          console.warn('[Checkout] ⚠️ CHECKOUT_CONTRACT_OWNER_PRIVATE_KEY not set. Status updated in DB only.');
        }
      } else {
        console.warn(`[Checkout] ⚠️ Order ${id} does not exist on blockchain. Status updated in DB only.`);
      }
    } catch (blockchainError) {
      console.error(`[Checkout] ❌ Failed to accept order on blockchain:`, blockchainError.message);
      // Continue with database update even if blockchain update fails
    }

    // Update status in database
    const updatedOrder = await checkoutService.updateOrderStatus(id, 'confirmed');

    // Trigger order.accepted webhook (AC2.5)
    try {
      const apiKeyResult = await pool.query(
        `SELECT id FROM vendor_api_keys WHERE vendor_address = $1 AND active = true LIMIT 1`,
        [order.vendor_address]
      );

      if (apiKeyResult.rows.length > 0) {
        await checkoutService.sendWebhook({
          vendorAddress: order.vendor_address,
          apiKeyId: apiKeyResult.rows[0].id,
          orderId: id,
          eventType: 'order.accepted',
          payload: {
            orderId: id,
            customerAddress: customerAddress.toLowerCase(),
            vendorAddress: order.vendor_address,
            totalAmount: order.total_amount,
            currency: order.currency,
            acceptedAt: new Date().toISOString(),
            status: 'confirmed'
          }
        });
      }
    } catch (webhookError) {
      console.warn('[Checkout] Error triggering order.accepted webhook:', webhookError.message);
    }

    res.json({
      success: true,
      data: updatedOrder,
      message: 'Order accepted successfully. Payment has been released to vendor.'
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Create checkout app
 * POST /api/checkout/apps
 */
async function createApp(req, res, next) {
  try {
    const { vendorAddress, appName, description, webhookUrl } = req.body;

    if (!vendorAddress || !appName) {
      return res.status(400).json({ 
        success: false, 
        error: 'Vendor address and app name are required' 
      });
    }

    const crypto = require('crypto');

    // Generate app ID (same format as subscription apps: app_<timestamp>_<random>)
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    const appId = `app_${timestamp}_${random}`;

    // Generate API key and secret
    const apiKey = `ck_${crypto.randomBytes(24).toString('hex')}`;
    const apiSecret = crypto.randomBytes(32).toString('hex');
    const apiSecretHash = crypto.createHash('sha256').update(apiSecret).digest('hex');

    // Determine network (default to localhost for checkout apps)
    const network = 'localhost';

    // Upsert vendor profile (ensure vendor exists in vendor_profiles table)
    try {
      await pool.query(
        `INSERT INTO vendor_profiles (vendor_address, network, updated_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (vendor_address) DO UPDATE SET
           network = EXCLUDED.network,
           updated_at = CURRENT_TIMESTAMP`,
        [vendorAddress.toLowerCase(), network]
      );
    } catch (vendorProfileError) {
      // Log error but don't fail app creation if vendor profile upsert fails
      console.warn('Warning: Failed to upsert vendor profile:', vendorProfileError.message);
    }

    // Create checkout app
    const result = await pool.query(
      `INSERT INTO checkout_apps 
       (app_id, vendor_address, api_key, api_secret_hash, app_name, description, webhook_url, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
       RETURNING *`,
      [
        appId,
        vendorAddress.toLowerCase(),
        apiKey,
        apiSecretHash,
        appName,
        description || null,
        webhookUrl || null
      ]
    );

    res.status(201).json({
      success: true,
      data: {
        appId: result.rows[0].app_id,
        apiKey: apiKey, // Return API key only on creation
        appName: result.rows[0].app_name,
        description: result.rows[0].description,
        webhookUrl: result.rows[0].webhook_url,
        status: result.rows[0].status,
        createdAt: result.rows[0].created_at
      },
      message: 'Checkout app created successfully'
    });
  } catch (error) {
    console.error('Error creating checkout app:', error);
    next(error);
  }
}

/**
 * Convert INR to Crypto
 */
async function convertToCrypto(req, res, next) {
  try {
    const { inrAmount, cryptoCoin = 'ETH' } = req.body;

    // Validation
    if (!inrAmount || inrAmount <= 0) {
      return res.status(400).json({ success: false, error: 'INR amount must be greater than 0' });
    }

    if (!cryptoCoin || !['ETH', 'USDT', 'MATIC'].includes(cryptoCoin.toUpperCase())) {
      return res.status(400).json({ success: false, error: 'Invalid crypto coin. Must be ETH, USDT, or MATIC' });
    }

    const result = await priceConversion.convertInrToCrypto(inrAmount, cryptoCoin);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('[Checkout] Conversion error:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Conversion failed'
    });
  }
}

/**
 * Get exchange rates
 */
async function getExchangeRates(req, res, next) {
  try {
    const rates = await priceConversion.getAllRates();

    res.json({
      success: true,
      data: rates
    });
  } catch (error) {
    console.error('[Checkout] Error fetching exchange rates:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch exchange rates'
    });
  }
}

module.exports = {
  registerVendor,
  generateApiKey,
  setWebhookUrl,
  setWebhookUrlByApiKey,
  createApp,
  createOrder,
  createBlockchainOrder,
  getOrder,
  getCustomerOrders,
  getVendorOrders,
  updateOrderStatus,
  acceptOrder,
  confirmPayment,
  cancelPayment,
  processRefund,
  convertToCrypto,
  getExchangeRates
};

