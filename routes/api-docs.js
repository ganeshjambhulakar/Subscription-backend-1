const express = require('express');
const router = express.Router();

/**
 * GET /api/docs
 * API Documentation endpoint
 */
router.get('/', (req, res) => {
  res.json({
    title: 'Elite Pass NFT Subscription Platform - API Documentation',
    version: '1.0.0',
    baseUrl: process.env.BACKEND_URL || 'http://localhost:3001',
    authentication: {
      type: 'Bearer Token',
      header: 'Authorization: Bearer <API_KEY>',
      description: 'All API requests require a valid API key in the Authorization header'
    },
    rateLimits: {
      default: '60 requests per minute per API key',
      headers: {
        'X-RateLimit-Limit': 'Maximum requests allowed',
        'X-RateLimit-Remaining': 'Remaining requests in current window',
        'X-RateLimit-Reset': 'Timestamp when rate limit resets'
      }
    },
    endpoints: {
      users: {
        'GET /api/integration/users/:userId': {
          description: 'Get user by external user ID',
          authentication: 'Required',
          permission: 'read',
          parameters: {
            userId: 'External user ID from partner platform'
          },
          response: {
            status: 'success',
            data: {
              id: 'integer',
              app_id: 'string',
              external_user_id: 'string',
              wallet_address: 'string',
              email: 'string',
              metadata: 'object'
            }
          }
        },
        'POST /api/integration/users': {
          description: 'Create or update external user',
          authentication: 'Required',
          permission: 'read-write',
          body: {
            userId: 'string (required)',
            walletAddress: 'string (optional)',
            email: 'string (optional)',
            metadata: 'object (optional)'
          },
          response: {
            status: 'success',
            data: 'User object'
          }
        }
      },
      subscriptions: {
        'GET /api/integration/subscriptions': {
          description: 'Get available subscription plans for the app',
          authentication: 'Required',
          permission: 'read',
          response: {
            status: 'success',
            data: [
              {
                planId: 'string',
                name: 'string',
                description: 'string',
                price: 'string',
                duration: 'integer',
                maxSubscriptions: 'integer',
                pauseEnabled: 'boolean',
                maxPauseAttempts: 'integer'
              }
            ]
          }
        }
      },
      checkout: {
        'POST /api/integration/checkout': {
          description: 'Initiate subscription checkout (INR or Crypto)',
          authentication: 'Required',
          permission: 'read-write',
          body: {
            userId: 'string (required)',
            planId: 'string (required)',
            paymentMethod: 'string (crypto|inr, default: crypto)',
            currency: 'string (ETH|USDT|MATIC, default: ETH)'
          },
          response: {
            status: 'success',
            data: {
              orderId: 'string',
              planId: 'string',
              amount: 'string',
              currency: 'string',
              paymentMethod: 'string',
              inrAmount: 'number',
              checkoutUrl: 'string',
              expiresAt: 'timestamp'
            }
          }
        }
      },
      mint: {
        'POST /api/integration/mint': {
          description: 'Auto-mint NFT after payment success',
          authentication: 'Required',
          permission: 'read-write',
          body: {
            orderId: 'string (required)',
            userId: 'string (required)',
            planId: 'string (required)'
          },
          response: {
            status: 'success',
            data: {
              subscriptionId: 'integer',
              orderId: 'string',
              planId: 'string',
              userId: 'string',
              status: 'active'
            }
          }
        }
      },
      validate: {
        'GET /api/integration/validate': {
          description: 'Validate subscription via NFT token ID',
          authentication: 'Required',
          permission: 'read',
          query: {
            tokenId: 'string (required) - NFT token ID'
          },
          response: {
            status: 'success',
            data: {
              tokenId: 'string',
              status: 'active|inactive|expired|cancelled',
              expiryDate: 'ISO timestamp',
              userId: 'string',
              planId: 'string',
              nextBillingDate: 'ISO timestamp',
              subscriptionPlan: {
                planId: 'string'
              }
            }
          }
        }
      }
    },
    webhooks: {
      description: 'Webhooks are automatically sent to the webhook_url configured for your API key',
      events: {
        subscription_active: {
          description: 'Triggered when a subscription becomes active',
          payload: {
            event: 'subscription_active',
            timestamp: 'ISO timestamp',
            data: {
              tokenId: 'string',
              userId: 'string',
              planId: 'string',
              expiryDate: 'ISO timestamp'
            }
          }
        },
        subscription_renewed: {
          description: 'Triggered when a subscription is renewed',
          payload: {
            event: 'subscription_renewed',
            timestamp: 'ISO timestamp',
            data: {
              tokenId: 'string',
              userId: 'string',
              planId: 'string',
              newExpiryDate: 'ISO timestamp'
            }
          }
        },
        subscription_cancelled: {
          description: 'Triggered when a subscription is cancelled',
          payload: {
            event: 'subscription_cancelled',
            timestamp: 'ISO timestamp',
            data: {
              tokenId: 'string',
              userId: 'string',
              planId: 'string'
            }
          }
        },
        subscription_expired: {
          description: 'Triggered when a subscription expires',
          payload: {
            event: 'subscription_expired',
            timestamp: 'ISO timestamp',
            data: {
              tokenId: 'string',
              userId: 'string',
              planId: 'string'
            }
          }
        }
      },
      retryPolicy: {
        maxAttempts: 6,
        backoff: 'Exponential (60s, 120s, 240s, 480s, 960s, 1920s)'
      }
    },
    errorCodes: {
      '400': 'Bad Request - Invalid parameters',
      '401': 'Unauthorized - Invalid or missing API key',
      '403': 'Forbidden - Insufficient permissions',
      '404': 'Not Found - Resource not found',
      '429': 'Rate Limit Exceeded - Too many requests',
      '500': 'Internal Server Error'
    },
    examples: {
      javascript: {
        title: 'JavaScript/Node.js Example',
        code: `
const axios = require('axios');

const API_KEY = 'your_api_key_here';
const BASE_URL = 'https://api.elitepass.com';

// Create user
async function createUser(userId, walletAddress) {
  const response = await axios.post(
    \`\${BASE_URL}/api/integration/users\`,
    {
      userId: userId,
      walletAddress: walletAddress
    },
    {
      headers: {
        'Authorization': \`Bearer \${API_KEY}\`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data;
}

// Get subscription plans
async function getPlans() {
  const response = await axios.get(
    \`\${BASE_URL}/api/integration/subscriptions\`,
    {
      headers: {
        'Authorization': \`Bearer \${API_KEY}\`
      }
    }
  );
  return response.data;
}

// Initiate checkout
async function checkout(userId, planId, paymentMethod = 'crypto') {
  const response = await axios.post(
    \`\${BASE_URL}/api/integration/checkout\`,
    {
      userId: userId,
      planId: planId,
      paymentMethod: paymentMethod
    },
    {
      headers: {
        'Authorization': \`Bearer \${API_KEY}\`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data;
}

// Validate subscription
async function validateSubscription(tokenId) {
  const response = await axios.get(
    \`\${BASE_URL}/api/integration/validate?tokenId=\${tokenId}\`,
    {
      headers: {
        'Authorization': \`Bearer \${API_KEY}\`
      }
    }
  );
  return response.data;
}
        `
      },
      php: {
        title: 'PHP Example',
        code: `
<?php

$apiKey = 'your_api_key_here';
$baseUrl = 'https://api.elitepass.com';

// Create user
function createUser($userId, $walletAddress) {
    global $apiKey, $baseUrl;
    
    $ch = curl_init(\$baseUrl . '/api/integration/users');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Authorization: Bearer ' . $apiKey,
        'Content-Type: application/json'
    ]);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
        'userId' => $userId,
        'walletAddress' => $walletAddress
    ]));
    
    $response = curl_exec($ch);
    curl_close($ch);
    
    return json_decode($response, true);
}

// Get subscription plans
function getPlans() {
    global $apiKey, $baseUrl;
    
    $ch = curl_init(\$baseUrl . '/api/integration/subscriptions');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Authorization: Bearer ' . $apiKey
    ]);
    
    $response = curl_exec($ch);
    curl_close($ch);
    
    return json_decode($response, true);
}

// Initiate checkout
function checkout($userId, $planId, $paymentMethod = 'crypto') {
    global $apiKey, $baseUrl;
    
    $ch = curl_init(\$baseUrl . '/api/integration/checkout');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Authorization: Bearer ' . $apiKey,
        'Content-Type: application/json'
    ]);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
        'userId' => $userId,
        'planId' => $planId,
        'paymentMethod' => $paymentMethod
    ]));
    
    $response = curl_exec($ch);
    curl_close($ch);
    
    return json_decode($response, true);
}

// Validate subscription
function validateSubscription($tokenId) {
    global $apiKey, $baseUrl;
    
    $ch = curl_init(\$baseUrl . '/api/integration/validate?tokenId=' . urlencode($tokenId));
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Authorization: Bearer ' . $apiKey
    ]);
    
    $response = curl_exec($ch);
    curl_close($ch);
    
    return json_decode($response, true);
}
?>
        `
      }
    }
  });
});

module.exports = router;


