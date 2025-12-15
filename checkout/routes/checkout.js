const express = require('express');
const router = express.Router();
const checkoutController = require('../controllers/checkoutController');

/**
 * Vendor Integration APIs
 */
router.post('/register-vendor', checkoutController.registerVendor);
router.post('/generate-api-key/:vendorAddress', checkoutController.generateApiKey);
router.post('/webhook-url/:vendorAddress', checkoutController.setWebhookUrl);
router.post('/webhook-url', checkoutController.setWebhookUrlByApiKey); // Set webhook URL via API key (AC5.1)
router.post('/apps', checkoutController.createApp); // Create checkout app

/**
 * Checkout Flow APIs
 */
router.post('/create-order', checkoutController.createOrder);
router.post('/create-blockchain-order', checkoutController.createBlockchainOrder);
router.get('/order/:id', checkoutController.getOrder);
router.put('/order/:id/status', checkoutController.updateOrderStatus);
router.get('/customer/:customerAddress/orders', checkoutController.getCustomerOrders);
router.get('/vendor/:vendorAddress/orders', checkoutController.getVendorOrders);
router.post('/order/:id/accept', checkoutController.acceptOrder);
router.post('/confirm-payment', checkoutController.confirmPayment);
router.post('/cancel-payment', checkoutController.cancelPayment);
router.post('/refund', checkoutController.processRefund);

/**
 * Price Conversion APIs
 */
router.post('/convert-to-crypto', checkoutController.convertToCrypto);
router.get('/exchange-rates', checkoutController.getExchangeRates);

module.exports = router;

