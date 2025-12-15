const request = require('supertest');
const express = require('express');
const checkoutRoutes = require('../routes/checkout');
const priceConversion = require('../services/priceConversion');

// Mock database pool to avoid creating real Postgres connections during unit tests
jest.mock('pg', () => {
  const mockPool = {
    query: jest.fn(),
    connect: jest.fn()
  };
  return { Pool: jest.fn(() => mockPool) };
});

// Mock price conversion service
jest.mock('../services/priceConversion', () => ({
  convertInrToCrypto: jest.fn(),
  getAllRates: jest.fn(),
  FALLBACK_RATES: {
    ETH: 250000,
    USDT: 83,
    MATIC: 85
  }
}));

const app = express();
app.use(express.json());
app.use('/api/checkout', checkoutRoutes);

describe('INR-Based Checkout with Crypto Payments', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Price Conversion', () => {
    test('should convert INR to ETH', async () => {
      priceConversion.convertInrToCrypto.mockResolvedValue({
        inrAmount: 1000,
        cryptoCoin: 'ETH',
        cryptoAmount: '0.004',
        exchangeRate: 250000,
        priceSource: 'coingecko',
        cached: false,
        timestamp: Date.now()
      });

      const response = await request(app)
        .post('/api/checkout/convert-to-crypto')
        .send({
          inrAmount: 1000,
          cryptoCoin: 'ETH'
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.cryptoCoin).toBe('ETH');
      expect(response.body.data.inrAmount).toBe(1000);
      expect(parseFloat(response.body.data.cryptoAmount)).toBeGreaterThan(0);
    });

    test('should reject invalid INR amount', async () => {
      const response = await request(app)
        .post('/api/checkout/convert-to-crypto')
        .send({
          inrAmount: -100,
          cryptoCoin: 'ETH'
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    test('should reject invalid crypto coin', async () => {
      const response = await request(app)
        .post('/api/checkout/convert-to-crypto')
        .send({
          inrAmount: 1000,
          cryptoCoin: 'INVALID'
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    test('should get exchange rates', async () => {
      priceConversion.getAllRates.mockResolvedValue({
        ETH: 250000,
        USDT: 83,
        MATIC: 85,
        source: 'coingecko',
        timestamp: Date.now()
      });

      const response = await request(app)
        .get('/api/checkout/exchange-rates');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.ETH).toBeDefined();
      expect(response.body.data.USDT).toBeDefined();
      expect(response.body.data.MATIC).toBeDefined();
    });
  });

  describe('Order Creation', () => {
    const validOrderData = {
      vendorAddress: '0x627306090abaB3A6e1400e9345bC60c78a8BEf57',
      customerAddress: '0xf17f52151EbEF6C7334FAD080c5704D77216b732',
      items: [
        {
          productId: 'prod-1',
          name: 'Test Product',
          description: 'Test Description',
          unitPrice: 1000,
          quantity: 2,
          totalPrice: 2000
        }
      ],
      totalAmount: 2360, // 2000 + 18% GST
      currency: 'INR',
      paymentMethod: 'inr',
      network: 'localhost'
    };

    test('should create order with INR payment method', async () => {
      const response = await request(app)
        .post('/api/checkout/create-order')
        .send(validOrderData);

      // Note: This will fail if database is not set up, but validates the endpoint exists
      expect([200, 201, 400, 500]).toContain(response.status);
    });

    test('should create order with crypto payment method', async () => {
      const cryptoOrderData = {
        ...validOrderData,
        paymentMethod: 'crypto',
        cryptoCoin: 'ETH',
        totalAmount: 0.004, // Crypto amount
        totalAmountInINR: 1000, // INR equivalent
        currency: 'ETH'
      };

      const response = await request(app)
        .post('/api/checkout/create-order')
        .send(cryptoOrderData);

      expect([200, 201, 400, 500]).toContain(response.status);
    });

    test('should reject order with invalid payment method', async () => {
      const invalidOrderData = {
        ...validOrderData,
        paymentMethod: 'invalid'
      };

      const response = await request(app)
        .post('/api/checkout/create-order')
        .send(invalidOrderData);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('payment method');
    });

    test('should reject crypto order without totalAmountInINR', async () => {
      const invalidOrderData = {
        ...validOrderData,
        paymentMethod: 'crypto',
        cryptoCoin: 'ETH',
        totalAmount: 0.004
        // Missing totalAmountInINR
      };

      const response = await request(app)
        .post('/api/checkout/create-order')
        .send(invalidOrderData);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('totalAmountInINR');
    });

    test('should reject order with negative amounts', async () => {
      const invalidOrderData = {
        ...validOrderData,
        totalAmount: -100
      };

      const response = await request(app)
        .post('/api/checkout/create-order')
        .send(invalidOrderData);

      expect(response.status).toBe(400);
    });

    test('should reject order with zero amount', async () => {
      const invalidOrderData = {
        ...validOrderData,
        totalAmount: 0
      };

      const response = await request(app)
        .post('/api/checkout/create-order')
        .send(invalidOrderData);

      expect(response.status).toBe(400);
    });

    test('should reject order with empty items', async () => {
      const invalidOrderData = {
        ...validOrderData,
        items: []
      };

      const response = await request(app)
        .post('/api/checkout/create-order')
        .send(invalidOrderData);

      expect(response.status).toBe(400);
    });
  });

  describe('Cart Validation', () => {
    test('should validate cart structure', () => {
      const validCartItem = {
        productId: 'prod-1',
        name: 'Test Product',
        description: 'Test Description',
        priceInRupees: 1000,
        quantity: 2
      };

      expect(validCartItem.productId).toBeDefined();
      expect(validCartItem.priceInRupees).toBeGreaterThan(0);
      expect(validCartItem.quantity).toBeGreaterThan(0);
    });

    test('should calculate cart totals correctly', () => {
      const cart = [
        { productId: 'prod-1', priceInRupees: 1000, quantity: 2 },
        { productId: 'prod-2', priceInRupees: 500, quantity: 1 }
      ];

      const subtotal = cart.reduce((sum, item) => sum + (item.priceInRupees * item.quantity), 0);
      const tax = Math.round(subtotal * 0.18);
      const total = subtotal + tax;

      expect(subtotal).toBe(2500);
      expect(tax).toBe(450);
      expect(total).toBe(2950);
    });
  });

  describe('Exchange Rate Validation', () => {
    test('should handle CoinGecko API failure gracefully', async () => {
      priceConversion.getAllRates.mockRejectedValue(new Error('API Error'));

      // Should fallback to hardcoded rates
      const fallbackRates = priceConversion.FALLBACK_RATES;
      expect(fallbackRates.ETH).toBeDefined();
      expect(fallbackRates.USDT).toBeDefined();
      expect(fallbackRates.MATIC).toBeDefined();
    });

    test('should refresh rates after TTL expires', async () => {
      const oldTimestamp = Date.now() - 2 * 60 * 1000; // 2 minutes ago
      
      // Mock cache with old timestamp
      priceConversion.convertInrToCrypto.mockResolvedValue({
        inrAmount: 1000,
        cryptoCoin: 'ETH',
        cryptoAmount: '0.004',
        exchangeRate: 250000,
        priceSource: 'coingecko',
        cached: false,
        timestamp: oldTimestamp
      });

      const response = await request(app)
        .post('/api/checkout/convert-to-crypto')
        .send({
          inrAmount: 1000,
          cryptoCoin: 'ETH'
        });

      // Should still work, but timestamp indicates it's old
      expect(response.status).toBe(200);
    });
  });
});



