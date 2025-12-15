# CDN Integration with Webhooks - Vendor Platform Guide

## Overview

This guide explains how to integrate Elite Pass Subscription and Checkout CDN into your vendor platform, enabling automatic synchronization of order statuses and subscription data via webhooks.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [CDN Integration](#cdn-integration)
3. [Webhook Setup](#webhook-setup)
4. [API Endpoints](#api-endpoints)
5. [Webhook Events](#webhook-events)
6. [Error Handling](#error-handling)
7. [Security](#security)
8. [Examples](#examples)

---

## Quick Start

### 1. Include CDN Script

Add the Elite Pass CDN script to your HTML page:

```html
<script src="https://your-backend-url/cdn/wallet.js"
        api-key="YOUR_API_KEY"
        data-app-id="YOUR_APP_ID"
        api-base-url="https://your-backend-url"></script>
```

### 2. Configure Webhook URL

Set your webhook endpoint to receive order and subscription updates:

```bash
curl -X POST https://your-backend-url/api/checkout/webhook-url \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "webhookUrl": "https://your-platform.com/webhooks/elitepass"
  }'
```

### 3. Handle Order Creation

When a customer places an order, the CDN response includes complete subscription data:

```javascript
// Order creation response includes subscriptionData
const response = await fetch('https://your-backend-url/api/checkout/create-order', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': 'YOUR_API_KEY'
  },
  body: JSON.stringify({
    vendorAddress: 'YOUR_VENDOR_ADDRESS',
    customerAddress: 'CUSTOMER_ADDRESS',
    items: [...],
    totalAmount: 0.1,
    currency: 'ETH',
    network: 'localhost'
  })
});

const data = await response.json();
// data.data.subscriptionData contains:
// - activeSubscriptions
// - subscriptionHistory
// - planDetails
// - summary
```

---

## CDN Integration

### Including the CDN Script

The CDN script can be included in your HTML page with the following attributes:

- `api-key`: Your API key (required)
- `data-app-id`: Your app ID (required)
- `api-base-url`: Backend API base URL (required)
- `data-theme`: UI theme ('light' or 'dark', optional)
- `data-language`: Language code (optional, default: 'en')

### Order Creation Response

When an order is created via the checkout CDN, the response includes:

```json
{
  "success": true,
  "data": {
    "order_id": "ORD-1234567890-abc123",
    "vendor_address": "0x...",
    "customer_address": "0x...",
    "total_amount": "0.1",
    "currency": "ETH",
    "status": "pending",
    "items": [...],
    "subscriptionData": {
      "activeSubscriptions": [
        {
          "tokenId": "1",
          "planId": "1",
          "planName": "Premium Plan",
          "planDescription": "...",
          "startTime": 1234567890,
          "endTime": 1234567890,
          "status": "active",
          "remainingDuration": 2592000,
          "remainingDurationDays": 30
        }
      ],
      "subscriptionHistory": [...],
      "planDetails": [...],
      "summary": {
        "totalSubscriptions": 5,
        "activeCount": 2,
        "nextExpiryDates": ["2024-02-01T00:00:00.000Z"],
        "totalSubscriptionValue": "1000000000000000000"
      }
    }
  }
}
```

---

## Webhook Setup

### Setting Webhook URL

You can set your webhook URL in two ways:

#### Option 1: Via API Key

```bash
curl -X POST https://your-backend-url/api/checkout/webhook-url \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "webhookUrl": "https://your-platform.com/webhooks/elitepass"
  }'
```

#### Option 2: Via Vendor Address

```bash
curl -X POST https://your-backend-url/api/checkout/webhook-url/VENDOR_ADDRESS \
  -H "Content-Type: application/json" \
  -d '{
    "webhookUrl": "https://your-platform.com/webhooks/elitepass",
    "appId": "YOUR_APP_ID"
  }'
```

### Webhook URL Requirements

- Must be a valid HTTPS URL (in production)
- Must be publicly accessible
- Should respond with 2xx status code within 10 seconds
- Should handle POST requests with JSON payload

---

## API Endpoints

### Get Subscription Data

Retrieve comprehensive subscription data for a customer:

```bash
GET /api/integration/subscriptions?customerAddress=0x...
```

**Query Parameters:**
- `customerAddress` (required): Customer wallet address
- `appId` (optional): Filter by app ID
- `planId` (optional): Filter by plan ID
- `status` (optional): Filter by status (active, expired, paused)
- `network` (optional): Network name (default: localhost)

**Response:**
```json
{
  "status": "success",
  "data": {
    "activeSubscriptions": [...],
    "subscriptionHistory": [...],
    "planDetails": [...],
    "summary": {...}
  }
}
```

### Get Order Data

Retrieve order data with subscription context:

```bash
GET /api/integration/orders?orderId=ORD-123
# OR
GET /api/integration/orders?customerAddress=0x...&page=1&limit=25
```

**Query Parameters:**
- `orderId` (optional): Specific order ID
- `customerAddress` (optional): Customer address
- `vendorAddress` (optional): Vendor address
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 25)
- `network` (optional): Network name (default: localhost)

**Response:**
```json
{
  "status": "success",
  "data": [
    {
      "order_id": "ORD-123",
      "customer_address": "0x...",
      "vendor_address": "0x...",
      "status": "paid",
      "subscriptionData": {...}
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 25,
    "total": 100,
    "totalPages": 4
  }
}
```

---

## Webhook Events

### Order Events

#### order.created

Triggered when a new order is created.

**Payload:**
```json
{
  "event": "order.created",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "data": {
    "order": {
      "orderId": "ORD-123",
      "customerAddress": "0x...",
      "vendorAddress": "0x...",
      "items": [...],
      "totalAmount": "0.1",
      "status": "pending",
      "createdAt": "2024-01-01T00:00:00.000Z"
    },
    "subscriptionData": {...}
  }
}
```

#### order.paid

Triggered when payment is received for an order.

**Payload:**
```json
{
  "event": "order.paid",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "data": {
    "order": {
      "orderId": "ORD-123",
      "status": "paid",
      ...
    },
    "transactionHash": "0x...",
    "paymentTimestamp": "2024-01-01T00:00:00.000Z",
    "subscriptionData": {...}
  }
}
```

#### order.confirmed

Triggered when an order is confirmed (by vendor or customer).

**Payload:**
```json
{
  "event": "order.confirmed",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "data": {
    "order": {
      "orderId": "ORD-123",
      "status": "confirmed",
      ...
    },
    "confirmationTimestamp": "2024-01-01T00:00:00.000Z"
  }
}
```

#### order.cancelled

Triggered when an order is cancelled.

**Payload:**
```json
{
  "event": "order.cancelled",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "data": {
    "order": {
      "orderId": "ORD-123",
      "status": "cancelled",
      ...
    },
    "cancellationReason": "Customer requested",
    "cancellationTimestamp": "2024-01-01T00:00:00.000Z"
  }
}
```

#### order.status_changed

Triggered when order status changes to any other status.

**Payload:**
```json
{
  "event": "order.status_changed",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "data": {
    "order": {
      "orderId": "ORD-123",
      "status": "delivered",
      ...
    },
    "previousStatus": "confirmed",
    "newStatus": "delivered",
    "statusChangeTimestamp": "2024-01-01T00:00:00.000Z"
  }
}
```

### Subscription Events

#### subscription.purchased

Triggered when a customer purchases a subscription.

**Payload:**
```json
{
  "event": "subscription.purchased",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "data": {
    "tokenId": "1",
    "planId": "1",
    "customerAddress": "0x...",
    "startTime": "1234567890",
    "endTime": "1234567890",
    "startTimeISO": "2024-01-01T00:00:00.000Z",
    "endTimeISO": "2024-02-01T00:00:00.000Z",
    "transactionHash": "0x...",
    "purchaseTimestamp": "2024-01-01T00:00:00.000Z",
    "plan": {
      "name": "Premium Plan",
      "description": "...",
      "price": "1000000000000000000"
    }
  }
}
```

#### subscription.renewed

Triggered when a subscription is renewed.

**Payload:**
```json
{
  "event": "subscription.renewed",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "data": {
    "tokenId": "1",
    "planId": "1",
    "customerAddress": "0x...",
    "previousEndTime": "1234567890",
    "previousEndTimeISO": "2024-01-01T00:00:00.000Z",
    "newEndTime": "1234567890",
    "newEndTimeISO": "2024-02-01T00:00:00.000Z",
    "renewalTransactionHash": "0x...",
    "renewalTimestamp": "2024-01-01T00:00:00.000Z",
    "plan": {...}
  }
}
```

#### subscription.expired

Triggered when a subscription expires.

**Payload:**
```json
{
  "event": "subscription.expired",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "data": {
    "tokenId": "1",
    "planId": "1",
    "customerAddress": "0x...",
    "endTime": "1234567890",
    "endTimeISO": "2024-01-01T00:00:00.000Z",
    "expiryTimestamp": "2024-01-01T00:00:00.000Z",
    "daysSinceExpiry": 0,
    "plan": {
      "name": "Premium Plan"
    }
  }
}
```

---

## Error Handling

### Error Response Format

All API errors follow a consistent format (AC7.2):

```json
{
  "status": "error",
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "requestId": "abc123def456"
  }
}
```

### Common Error Codes

- `UNAUTHORIZED`: Invalid or missing API key
- `VALIDATION_ERROR`: Invalid request parameters
- `NOT_FOUND`: Resource not found
- `RATE_LIMIT_EXCEEDED`: Too many requests
- `DATABASE_CONNECTION_ERROR`: Database unavailable
- `INTERNAL_ERROR`: Unexpected server error

### Webhook Failure Handling

If a webhook fails to deliver:

1. The system logs the failure
2. Retries with exponential backoff (60s, 120s, 240s, 480s, 960s)
3. Maximum 5 retry attempts
4. After max attempts, webhook is marked as permanently failed
5. Failed webhooks can be viewed in admin dashboard

---

## Security

### API Key Authentication

All API requests require authentication via API key:

```bash
# Option 1: X-API-Key header
curl -H "X-API-Key: YOUR_API_KEY" https://your-backend-url/api/...

# Option 2: Authorization header
curl -H "Authorization: Bearer YOUR_API_KEY" https://your-backend-url/api/...
```

### Webhook Signature Verification

Webhooks include an HMAC signature for verification (AC5.2):

**Header:**
```
X-Webhook-Signature: <hmac-sha256-signature>
```

**Verification (Node.js example):**
```javascript
const crypto = require('crypto');

function verifyWebhookSignature(payload, signature, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(JSON.stringify(payload));
  const expectedSignature = hmac.digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

// In your webhook endpoint
app.post('/webhooks/elitepass', (req, res) => {
  const signature = req.headers['x-webhook-signature'];
  const isValid = verifyWebhookSignature(
    req.body,
    signature,
    process.env.API_SECRET
  );
  
  if (!isValid) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  // Process webhook...
});
```

### Rate Limiting

API requests are rate-limited per API key:

- Default: 60 requests per minute
- Headers included in response:
  - `X-RateLimit-Limit`: Maximum requests allowed
  - `X-RateLimit-Remaining`: Remaining requests
  - `X-RateLimit-Reset`: Reset timestamp

---

## Examples

### Complete Integration Example

```html
<!DOCTYPE html>
<html>
<head>
  <title>Vendor Platform</title>
  <script src="https://your-backend-url/cdn/wallet.js"
          api-key="YOUR_API_KEY"
          data-app-id="YOUR_APP_ID"
          api-base-url="https://your-backend-url"></script>
</head>
<body>
  <div id="checkout-container"></div>
  
  <script>
    // Handle order creation
    async function createOrder(orderData) {
      const response = await fetch('https://your-backend-url/api/checkout/create-order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'YOUR_API_KEY'
        },
        body: JSON.stringify(orderData)
      });
      
      const result = await response.json();
      
      if (result.success) {
        // Order created with subscription data
        const order = result.data;
        const subscriptionData = order.subscriptionData;
        
        // Use subscription data in your platform
        console.log('Active subscriptions:', subscriptionData.activeSubscriptions);
        console.log('Subscription history:', subscriptionData.subscriptionHistory);
        console.log('Summary:', subscriptionData.summary);
        
        // Webhook will be sent automatically
        return order;
      } else {
        throw new Error(result.error.message);
      }
    }
    
    // Webhook endpoint handler (on your backend)
    // POST /webhooks/elitepass
    async function handleWebhook(req, res) {
      const signature = req.headers['x-webhook-signature'];
      
      // Verify signature
      if (!verifyWebhookSignature(req.body, signature, process.env.API_SECRET)) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
      
      const { event, data, timestamp } = req.body;
      
      switch (event) {
        case 'order.created':
          await handleOrderCreated(data);
          break;
        case 'order.paid':
          await handleOrderPaid(data);
          break;
        case 'order.status_changed':
          await handleOrderStatusChanged(data);
          break;
        case 'subscription.purchased':
          await handleSubscriptionPurchased(data);
          break;
        // ... handle other events
      }
      
      res.json({ received: true });
    }
  </script>
</body>
</html>
```

### Webhook Endpoint Example (Express.js)

```javascript
const express = require('express');
const crypto = require('crypto');
const app = express();

app.use(express.json());

function verifyWebhookSignature(payload, signature, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(JSON.stringify(payload));
  const expectedSignature = hmac.digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

app.post('/webhooks/elitepass', async (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'];
    const apiSecret = process.env.ELITEPASS_API_SECRET;
    
    // Verify signature
    if (!verifyWebhookSignature(req.body, signature, apiSecret)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    
    const { event, data, timestamp } = req.body;
    
    // Process webhook based on event type
    switch (event) {
      case 'order.created':
        await syncOrderToDatabase(data.order);
        await updateCustomerSubscriptionData(data.order.customerAddress, data.subscriptionData);
        break;
        
      case 'order.paid':
        await updateOrderStatus(data.order.orderId, 'paid');
        await processPayment(data.order);
        break;
        
      case 'order.status_changed':
        await updateOrderStatus(data.order.orderId, data.newStatus);
        break;
        
      case 'subscription.purchased':
        await syncSubscriptionToDatabase(data);
        break;
        
      case 'subscription.renewed':
        await updateSubscriptionExpiry(data.tokenId, data.newEndTime);
        break;
        
      case 'subscription.expired':
        await handleSubscriptionExpiry(data);
        break;
    }
    
    // Always return 200 to acknowledge receipt
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    // Still return 200 to prevent retries for processing errors
    res.status(200).json({ received: true, error: error.message });
  }
});

app.listen(3000, () => {
  console.log('Webhook server running on port 3000');
});
```

---

## Testing

### Test Webhook Endpoint

Use a service like [webhook.site](https://webhook.site) to test webhook delivery:

1. Get a test webhook URL from webhook.site
2. Set it as your webhook URL via API
3. Create an order or trigger an event
4. Check webhook.site to see the received payload

### Test API Endpoints

```bash
# Test subscription data retrieval
curl -H "X-API-Key: YOUR_API_KEY" \
  "https://your-backend-url/api/integration/subscriptions?customerAddress=0x..."

# Test order data retrieval
curl -H "X-API-Key: YOUR_API_KEY" \
  "https://your-backend-url/api/integration/orders?customerAddress=0x..."
```

---

## Support

For issues or questions:

1. Check browser console for errors
2. Verify API key is valid and active
3. Ensure webhook URL is accessible
4. Check webhook logs in admin dashboard
5. Review error responses for request IDs

---

## Changelog

- **v1.0.0**: Initial release with full webhook support and subscription data integration


