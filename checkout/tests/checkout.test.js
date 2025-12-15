const { Pool } = require('pg');
const checkoutService = require('../services/checkoutService');
require('dotenv').config();

const runDbTests = process.env.RUN_DB_TESTS === 'true';
const maybeDescribe = runDbTests ? describe : describe.skip;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

maybeDescribe('Checkout Service Tests', () => {
  let testVendorAddress = '0x627306090abaB3A6e1400e9345bC60c78a8BEf57';
  let testOrderId;

  beforeAll(async () => {
    // Clean up test data
    await pool.query('DELETE FROM checkout_orders WHERE vendor_address = $1', [testVendorAddress]);
  });

  afterAll(async () => {
    await pool.end();
  });

  test('Register vendor', async () => {
    const result = await checkoutService.registerVendor(testVendorAddress, {
      name: 'Test Vendor',
      email: 'test@example.com'
    });

    expect(result).toHaveProperty('vendor_address');
    expect(result).toHaveProperty('api_key');
    expect(result.vendor_address.toLowerCase()).toBe(testVendorAddress.toLowerCase());
  });

  test('Create order', async () => {
    const order = await checkoutService.createOrder({
      vendorAddress: testVendorAddress,
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
      network: 'localhost'
    });

    expect(order).toHaveProperty('order_id');
    expect(order.vendor_address.toLowerCase()).toBe(testVendorAddress.toLowerCase());
    expect(order.total_amount).toBe('0.1');
    expect(order.status).toBe('pending');

    testOrderId = order.order_id;
  });

  test('Get order', async () => {
    const order = await checkoutService.getOrder(testOrderId);

    expect(order).not.toBeNull();
    expect(order.order_id).toBe(testOrderId);
    expect(order.items).toHaveLength(1);
    expect(order.items[0].product_name).toBe('Test Product');
  });

  test('Update order status', async () => {
    const order = await checkoutService.updateOrderStatus(testOrderId, 'paid', '0x1234567890abcdef');

    expect(order.status).toBe('paid');
    expect(order.transaction_hash).toBe('0x1234567890abcdef');
  });

  test('Verify API key', async () => {
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

  test('Process refund', async () => {
    // First update order to paid status
    await checkoutService.updateOrderStatus(testOrderId, 'paid');

    const order = await checkoutService.processRefund(testOrderId, testVendorAddress);

    expect(order.status).toBe('refunded');
  });
});

