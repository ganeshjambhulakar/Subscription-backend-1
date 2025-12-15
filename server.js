const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const subscriptionRoutes = require('./routes/subscription');
const subscriptionRenewRoutes = require('./routes/subscription-renew');
const subscriptionPublishRoutes = require('./routes/subscription-publish');
const planRoutes = require('./routes/plans');
const customerRoutes = require('./routes/customers');
const vendorRoutes = require('./routes/vendors');
const appRoutes = require('./routes/apps');
const blockchainVerifyRoutes = require('./routes/blockchain-verify');
const adminRoutes = require('./routes/admin');
const vendorTableRoutes = require('./routes/vendor-tables');
const contractDeploymentsRoutes = require('./routes/contract-deployments');
const contractArtifactsRoutes = require('./routes/contract-artifacts');
const checkoutRoutes = require('./checkout/routes/checkout');
const apiIntegrationRoutes = require('./routes/api-integration');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Handle OPTIONS requests with null origin BEFORE CORS middleware
// When origin is null, Access-Control-Allow-Origin must be '*' not 'null'
app.use((req, res, next) => {
  if (req.method === 'OPTIONS' && (req.headers.origin === 'null' || (!req.headers.origin && process.env.NODE_ENV !== 'production'))) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Key,X-Vendor-Address');
    return res.status(200).end();
  }
  // Store flag for POST/GET requests
  if (req.headers.origin === 'null' || (!req.headers.origin && process.env.NODE_ENV !== 'production')) {
    req._nullOrigin = true;
  }
  next();
});

// Middleware
// Default CORS for internal routes (frontend)
// External API routes will use dynamicCors middleware instead
// Allow null origin for local file access (file:// protocol) in development
app.use(cors({
  origin: (origin, callback) => {
    // Allow null origin (file:// protocol) in development
    if (!origin || origin === 'null') {
      if (process.env.NODE_ENV !== 'production') {
        return callback(null, true);
      }
    }
    // Allow configured frontend URL
    const allowedOrigins = [process.env.FRONTEND_URL || 'http://localhost:3000'];
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    // In development, allow all origins
    if (process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Vendor-Address']
}));

// Override CORS headers for null origin after CORS middleware sets them
app.use((req, res, next) => {
  if (req._nullOrigin) {
    // Override CORS headers for null origin
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Cannot use credentials with wildcard origin
    res.removeHeader('Access-Control-Allow-Credentials');
  }
  next();
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Test database connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('✅ Database connected successfully');
  }
});

// Routes
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'subscription-backend'
  });
});

// Public maintenance status endpoint
app.get('/api/maintenance-status', async (req, res) => {
  try {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });

    const { entityType } = req.query;

    let query = `SELECT * FROM maintenance_mode WHERE enabled = true`;
    const params = [];

    if (entityType) {
      query += ` AND entity_type = $1`;
      params.push(entityType);
    }

    const result = await pool.query(query, params);

    if (entityType) {
      // Return single entity status
      if (result.rows.length === 0) {
        return res.json({
          enabled: false,
          message: null,
          entityType
        });
      }

      const row = result.rows[0];
      res.json({
        enabled: true,
        message: row.message,
        entityType: row.entity_type,
        enabledAt: row.enabled_at
      });
    } else {
      // Return all enabled maintenance modes
      const maintenanceStatus = {};
      result.rows.forEach(row => {
        maintenanceStatus[row.entity_type] = {
          enabled: true,
          message: row.message,
          enabledAt: row.enabled_at
        };
      });

      res.json({
        maintenanceMode: maintenanceStatus,
        anyEnabled: result.rows.length > 0
      });
    }
  } catch (error) {
    console.error('Error fetching maintenance status:', error);
    res.json({
      maintenanceMode: {},
      anyEnabled: false,
      error: 'Failed to fetch maintenance status'
    });
  }
});

// Contract address endpoint for frontend (supports network parameter)
app.get('/api/contract-address', async (req, res) => {
  try {
    const { network, chainId, contractType } = req.query;
    const targetNetwork = network || 'localhost';
    const targetContractType = (contractType || 'unified').toString();
    
    // Try to load from database first
    try {
      let result;

      if (chainId) {
        const parsedChainId = parseInt(chainId, 10);
        if (!Number.isFinite(parsedChainId)) {
          return res.status(400).json({ error: 'Invalid chainId' });
        }
        result = await pool.query(
          `SELECT *
           FROM contract_deployments
           WHERE chain_id = $1 AND contract_type = $2
           ORDER BY updated_at DESC
           LIMIT 1`,
          [parsedChainId, targetContractType]
        );
      } else {
        result = await pool.query(
          `SELECT *
           FROM contract_deployments
           WHERE network = $1 AND contract_type = $2
           ORDER BY updated_at DESC
           LIMIT 1`,
          [targetNetwork, targetContractType]
      );
      }
      
      if (result.rows.length > 0) {
        const deployment = result.rows[0];
        return res.json({
          network: deployment.network,
          chainId: deployment.chain_id.toString(),
          contractAddress: deployment.contract_address,
          deployer: deployment.deployer_address,
          transactionHash: deployment.transaction_hash,
          blockNumber: deployment.block_number,
          rpcUrl: deployment.rpc_url || null,
          contractType: deployment.contract_type || 'unified'
        });
      }
    } catch (dbError) {
      console.warn('Could not load from database, trying config file:', dbError.message);
    }
    
    // Fallback: Load from config file
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(__dirname, 'config/contract-address.json');
    
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config && config.contractAddress && (config.network === targetNetwork || !network)) {
        return res.json(config);
      }
    }
    
    res.status(404).json({ 
      error: `Contract address not found for network: ${targetNetwork}`,
      message: `Please deploy the contract to ${targetNetwork} first.`
    });
  } catch (error) {
    console.error('Error loading contract address:', error);
    res.status(500).json({ 
      error: 'Failed to load contract address',
      message: error.message 
    });
  }
});

// Internal routes (no CORS validation required)
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/subscriptions', subscriptionPublishRoutes);
app.use('/api/plans', planRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/vendors', vendorRoutes);
app.use('/api/apps', appRoutes);
app.use('/api/verify', blockchainVerifyRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/vendor', vendorTableRoutes);
app.use('/api/vendor', require('./routes/vendor-domains'));
app.use('/api/vendor', require('./routes/domain-verification'));
app.use('/api/contract-deployments', contractDeploymentsRoutes);
app.use('/api/contract-artifacts', contractArtifactsRoutes);

// External API routes (require CORS validation)
const dynamicCors = require('./middleware/dynamicCors');
app.use('/api/checkout', dynamicCors, checkoutRoutes);

// CDN integration routes - register FIRST so validate-key is accessible
// validate-key endpoint uses publicCors (defined in route file)
// and is skipped by dynamicCors middleware (see dynamicCors.js)
const cdnIntegrationRoutes = require('./routes/cdn-integration');
app.use('/api/integration', cdnIntegrationRoutes);

// Other integration routes (require CORS validation)
app.use('/api/integration', dynamicCors, apiIntegrationRoutes);

// API key management and docs (no CORS - internal use)
app.use('/api/api-keys', require('./routes/api-keys'));
app.use('/api/docs', require('./routes/api-docs'));

// Webhook management routes
app.use('/api/webhooks', require('./routes/webhooks'));

// CDN routes (publicly accessible, no CORS validation)
app.use('/cdn', require('./routes/cdn'));

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: {
      message: 'Route not found',
      path: req.path,
      method: req.method
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  console.error('Stack:', err.stack);
  
  // Don't send response if headers already sent
  if (res.headersSent) {
    return next(err);
  }
  
  // Handle database connection errors
  if (err.code === 'ECONNREFUSED' || err.message?.includes('connect ECONNREFUSED')) {
    return res.status(503).json({
      error: {
        message: 'Database connection failed',
        status: 503,
        details: 'Please ensure PostgreSQL is running and DATABASE_URL is configured correctly.'
      }
    });
  }
  
  // Handle other errors
  res.status(err.status || 500).json({
    error: {
      message: err.message || 'Internal server error',
      status: err.status || 500
    }
  });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit the process, just log it
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Don't exit the process, just log it
});

// Initialize database on startup
const initializeDatabase = async () => {
  try {
    const { exec } = require('child_process');
    exec('npm run migrate', (error, stdout, stderr) => {
      if (error) {
        console.log('Note: Database migrations may need to be run manually');
        console.log('Run: docker compose exec backend npm run migrate');
      } else {
        console.log('✅ Database initialized');
      }
    });
  } catch (error) {
    console.log('Database initialization will be done manually');
  }
};

// Start webhook retry worker
const webhookService = require('./services/webhookService');
webhookService.startWebhookWorker();

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend server running on port ${PORT}`);
  console.log(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📚 API Integration available at /api/integration`);
  console.log(`📖 API Documentation available at /api/docs`);
  initializeDatabase();
});

// Handle SIGTERM gracefully
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// Enhanced error handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  console.error('Stack:', reason?.stack);
  // Don't exit the process, just log it
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  console.error('Stack:', error.stack);
  // Don't exit the process, just log it
});

module.exports = { app, server };

