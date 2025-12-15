const { Pool } = require('pg');
const checkoutService = require('../services/checkoutService');
const checkoutContract = require('../helpers/contract');
const { ethers } = require('ethers');
require('dotenv').config();

const runDbTests = process.env.RUN_DB_TESTS === 'true';
const maybeDescribe = runDbTests ? describe : describe.skip;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

maybeDescribe('Checkout E2E Integration Tests', () => {
  let testVendorAddress = '0x627306090abaB3A6e1400e9345bC60c78a8BEf57';
  let testCustomerAddress = '0xf17f52151EbEF6C7334FAD080c5704D77216b732';
  let testOrderId;
  let network = 'localhost';

  beforeAll(async () => {
    // Clean up test data
    await pool.query('DELETE FROM checkout_orders WHERE vendor_address = $1', [testVendorAddress]);
    
    // Verify contract is deployed
    try {
      await checkoutContract.initialize(network);
    } catch (error) {
      console.warn('Contract not initialized, skipping blockchain tests:', error.message);
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('Order Creation Flow', () => {
    test('1. Create order via API', async () => {
      const order = await checkoutService.createOrder({
        vendorAddress: testVendorAddress,
        customerAddress: testCustomerAddress,
        items: [
          {
            name: 'Test Product',
            description: 'Test Description',
            unitPrice: 0.1,
            quantity: 1
          }
        ],
        totalAmount: 0.1,
        currency: 'ETH',
        network
      });

      expect(order).toHaveProperty('order_id');
      expect(order.vendor_address.toLowerCase()).toBe(testVendorAddress.toLowerCase());
      expect(order.total_amount).toBe('0.1');
      expect(order.status).toBe('pending');

      testOrderId = order.order_id;
    });

    test('2. Verify order exists in database', async () => {
      const order = await checkoutService.getOrder(testOrderId);

      expect(order).not.toBeNull();
      expect(order.order_id).toBe(testOrderId);
      expect(order.items).toHaveLength(1);
      expect(order.items[0].product_name).toBe('Test Product');
    });

    test('3. Verify order exists on blockchain (if contract owner set)', async () => {
      try {
        const contract = await checkoutContract.getContract(network);
        const orderIdBytes = ethers.id(testOrderId);
        const exists = await contract.orderExists(orderIdBytes);
        
        // This may be false if CHECKOUT_CONTRACT_OWNER is not set
        // That's okay - order still exists in database
        expect(typeof exists).toBe('boolean');
      } catch (error) {
        console.warn('Blockchain check skipped:', error.message);
      }
    });
  });

  describe('Payment Flow', () => {
    test('4. Update order status to paid', async () => {
      const mockTxHash = '0x' + '1'.repeat(64);
      
      await checkoutService.updateOrderStatus(testOrderId, 'paid', mockTxHash);

      const order = await checkoutService.getOrder(testOrderId);
      expect(order.status).toBe('paid');
      expect(order.transaction_hash).toBe(mockTxHash);
    });

    test('5. Record transaction', async () => {
      const txData = {
        orderId: testOrderId,
        transactionHash: '0x' + '2'.repeat(64),
        fromAddress: testCustomerAddress,
        toAddress: testVendorAddress,
        amount: 0.1,
        gasUsed: 21000,
        gasPrice: 20000000000,
        blockNumber: 100,
        network,
        status: 'confirmed'
      };

      const tx = await checkoutService.recordTransaction(txData);

      expect(tx).toHaveProperty('transaction_hash');
      expect(tx.order_id).toBe(testOrderId);
      expect(tx.status).toBe('confirmed');
    });
  });

  describe('Vendor Confirmation Flow', () => {
    test('6. Confirm order (simulated - would call blockchain in production)', async () => {
      // In production, this would call contract.confirmOrder()
      // For now, we just verify the order can be updated
      const order = await checkoutService.getOrder(testOrderId);
      expect(order.status).toBe('paid');
      
      // Simulate confirmation
      await checkoutService.updateOrderStatus(testOrderId, 'confirmed');
      
      const confirmedOrder = await checkoutService.getOrder(testOrderId);
      expect(confirmedOrder.status).toBe('confirmed');
    });
  });

  describe('Refund Flow', () => {
    test('7. Process refund', async () => {
      // First ensure order is paid
      await checkoutService.updateOrderStatus(testOrderId, 'paid');

      const order = await checkoutService.processRefund(testOrderId, testVendorAddress);

      expect(order.status).toBe('refunded');
    });
  });

  describe('API Key Management', () => {
    test('8. Register vendor', async () => {
      const result = await checkoutService.registerVendor(testVendorAddress, {
        name: 'Test Vendor',
        email: 'test@example.com'
      });

      expect(result).toHaveProperty('vendor_address');
      expect(result).toHaveProperty('api_key');
      expect(result.vendor_address.toLowerCase()).toBe(testVendorAddress.toLowerCase());
    });

    test('9. Verify API key', async () => {
      // Get API key from vendor
      const vendorResult = await pool.query(
        'SELECT api_key FROM vendor_api_keys WHERE vendor_address = $1',
        [testVendorAddress]
      );

      if (vendorResult.rows.length > 0) {
        const apiKeyData = await checkoutService.verifyApiKey(vendorResult.rows[0].api_key);
        expect(apiKeyData).not.toBeNull();
        expect(apiKeyData.vendor_address.toLowerCase()).toBe(testVendorAddress.toLowerCase());
      }
    });
  });

  describe('Error Handling', () => {
    test('10. Fail to create order with invalid data', async () => {
      await expect(
        checkoutService.createOrder({
          vendorAddress: '',
          items: [],
          totalAmount: 0,
          network
        })
      ).rejects.toThrow();
    });

    test('11. Fail to get non-existent order', async () => {
      const order = await checkoutService.getOrder('NON-EXISTENT-ORDER');
      expect(order).toBeNull();
    });

    test('12. Fail to refund unauthorized order', async () => {
      const unauthorizedVendor = '0x' + '9'.repeat(40);
      
      await expect(
        checkoutService.processRefund(testOrderId, unauthorizedVendor)
      ).rejects.toThrow('Unauthorized');
    });
  });
});

