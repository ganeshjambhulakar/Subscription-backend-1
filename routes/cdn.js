const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

/**
 * GET /cdn/subscriptions.js
 * Serve the Elite Pass subscription UI script
 */
router.get('/subscriptions.js', (req, res) => {
  // Try multiple possible paths
  const possiblePaths = [
    path.join(__dirname, '../../integration-service/cdn/subscriptions.js'),
    path.join(process.cwd(), 'integration-service/cdn/subscriptions.js'),
    path.join(__dirname, '../integration-service/cdn/subscriptions.js'),
    '/app/integration-service/cdn/subscriptions.js',
    path.join(process.cwd(), '/app/integration-service/cdn/subscriptions.js')
  ];
  
  let scriptPath = null;
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      scriptPath = p;
      break;
    }
  }
  
  if (!scriptPath) {
    return res.status(404).json({
      error: 'Script not found',
      searched: possiblePaths
    });
  }

  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const script = fs.readFileSync(scriptPath, 'utf8');
  res.send(script);
});

/**
 * GET /cdn/wallet.js
 * Serve the Elite Pass wallet integration script (latest, unminified for dev)
 */
router.get('/wallet.js', (req, res) => {
  // In production, serve minified; in dev, serve unminified
  const useMinified = process.env.NODE_ENV === 'production';
  
  let scriptPath = null;
  if (useMinified) {
    // Try minified version first
    const minifiedPaths = [
      path.join(__dirname, '../../integration-service/cdn/dist/wallet.latest.min.js'),
      path.join(process.cwd(), 'integration-service/cdn/dist/wallet.latest.min.js'),
      path.join(__dirname, '../integration-service/cdn/dist/wallet.latest.min.js'),
      '/app/integration-service/cdn/dist/wallet.latest.min.js'
    ];
    
    for (const p of minifiedPaths) {
      if (fs.existsSync(p)) {
        scriptPath = p;
        break;
      }
    }
  }
  
  // Fallback to unminified source
  if (!scriptPath) {
    const possiblePaths = [
      path.join(__dirname, '../../integration-service/cdn/wallet.js'),
      path.join(process.cwd(), 'integration-service/cdn/wallet.js'),
      path.join(__dirname, '../integration-service/cdn/wallet.js'),
      '/app/integration-service/cdn/wallet.js',
      path.join(process.cwd(), '/app/integration-service/cdn/wallet.js')
    ];
    
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        scriptPath = p;
        break;
      }
    }
  }
  
  if (!scriptPath) {
    return res.status(404).json({
      error: 'Wallet script not found'
    });
  }

  res.setHeader('Content-Type', 'application/javascript');
  // Disable caching in development, enable in production
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour in production
  } else {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); // No cache in development
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  const script = fs.readFileSync(scriptPath, 'utf8');
  res.send(script);
});

/**
 * GET /cdn/wallet.v:version.js
 * Serve versioned wallet script (minified)
 */
router.get('/wallet.v:version.js', (req, res) => {
  const version = req.params.version;
  
  // Try minified version first
  const minifiedPaths = [
    path.join(__dirname, `../../integration-service/cdn/dist/wallet.${version}.min.js`),
    path.join(process.cwd(), `integration-service/cdn/dist/wallet.${version}.min.js`),
    path.join(__dirname, `../integration-service/cdn/dist/wallet.${version}.min.js`),
    `/app/integration-service/cdn/dist/wallet.${version}.min.js`
  ];
  
  let scriptPath = null;
  for (const p of minifiedPaths) {
    if (fs.existsSync(p)) {
      scriptPath = p;
      break;
    }
  }
  
  // Fallback to unminified source if minified doesn't exist
  if (!scriptPath) {
    const possiblePaths = [
      path.join(__dirname, '../../integration-service/cdn/wallet.js'),
      path.join(process.cwd(), 'integration-service/cdn/wallet.js'),
      path.join(__dirname, '../integration-service/cdn/wallet.js'),
      '/app/integration-service/cdn/wallet.js'
    ];
    
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        scriptPath = p;
        break;
      }
    }
  }
  
  if (!scriptPath) {
    return res.status(404).json({
      error: `Wallet script version ${version} not found`
    });
  }

  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year (versioned)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  const script = fs.readFileSync(scriptPath, 'utf8');
  res.send(script);
});

/**
 * GET /cdn/wallet.min.js
 * Serve minified wallet script (latest)
 */
router.get('/wallet.min.js', (req, res) => {
  const minifiedPaths = [
    path.join(__dirname, '../../integration-service/cdn/dist/wallet.latest.min.js'),
    path.join(process.cwd(), 'integration-service/cdn/dist/wallet.latest.min.js'),
    path.join(__dirname, '../integration-service/cdn/dist/wallet.latest.min.js'),
    '/app/integration-service/cdn/dist/wallet.latest.min.js'
  ];
  
  let scriptPath = null;
  for (const p of minifiedPaths) {
    if (fs.existsSync(p)) {
      scriptPath = p;
      break;
    }
  }
  
  if (!scriptPath) {
    return res.status(404).json({
      error: 'Minified wallet script not found. Run: npm run build:cdn'
    });
  }

  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  const script = fs.readFileSync(scriptPath, 'utf8');
  res.send(script);
});

/**
 * GET /cdn/subscriptions.css
 * Serve the Elite Pass subscription UI styles
 */
router.get('/subscriptions.css', (req, res) => {
  // Try multiple possible paths
  const possiblePaths = [
    path.join(__dirname, '../../integration-service/cdn/subscriptions.css'),
    path.join(process.cwd(), 'integration-service/cdn/subscriptions.css'),
    path.join(__dirname, '../integration-service/cdn/subscriptions.css'),
    '/app/integration-service/cdn/subscriptions.css',
    path.join(process.cwd(), '/app/integration-service/cdn/subscriptions.css')
  ];
  
  let cssPath = null;
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      cssPath = p;
      break;
    }
  }
  
  if (!cssPath) {
    return res.status(404).json({
      error: 'Stylesheet not found',
      searched: possiblePaths
    });
  }

  res.setHeader('Content-Type', 'text/css');
  res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const css = fs.readFileSync(cssPath, 'utf8');
  res.send(css);
});

/**
 * GET /cdn/subscriptions.v:version.js
 * Serve versioned script (for cache busting)
 */
router.get('/subscriptions.v:version.js', (req, res) => {
  const version = req.params.version;
  // Try multiple possible paths
  const possiblePaths = [
    path.join(__dirname, '../../integration-service/cdn/subscriptions.js'),
    path.join(process.cwd(), 'integration-service/cdn/subscriptions.js'),
    path.join(__dirname, '../integration-service/cdn/subscriptions.js')
  ];
  
  let scriptPath = null;
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      scriptPath = p;
      break;
    }
  }
  
  if (!scriptPath) {
    return res.status(404).json({
      error: 'Script not found',
      searched: possiblePaths
    });
  }

  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year (versioned)
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const script = fs.readFileSync(scriptPath, 'utf8');
  res.send(script);
});

/**
 * GET /cdn/subscriptions.v:version.css
 * Serve versioned stylesheet (for cache busting)
 */
router.get('/subscriptions.v:version.css', (req, res) => {
  const version = req.params.version;
  // Try multiple possible paths
  const possiblePaths = [
    path.join(__dirname, '../../integration-service/cdn/subscriptions.css'),
    path.join(process.cwd(), 'integration-service/cdn/subscriptions.css'),
    path.join(__dirname, '../integration-service/cdn/subscriptions.css')
  ];
  
  let cssPath = null;
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      cssPath = p;
      break;
    }
  }
  
  if (!cssPath) {
    return res.status(404).json({
      error: 'Stylesheet not found',
      searched: possiblePaths
    });
  }

  res.setHeader('Content-Type', 'text/css');
  res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year (versioned)
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const css = fs.readFileSync(cssPath, 'utf8');
  res.send(css);
});

/**
 * GET /cdn/version
 * Get current CDN version information
 */
router.get('/version', (req, res) => {
  const versionFile = path.join(__dirname, '../../integration-service/cdn/version.json');
  
  let versionInfo = {
    version: '1.0.0',
    wallet: {
      version: '1.0.0',
      minified: 'wallet.1.0.0.min.js',
      latest: 'wallet.latest.min.js'
    }
  };
  
  if (fs.existsSync(versionFile)) {
    try {
      versionInfo = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
    } catch (e) {
      console.warn('Could not read version file:', e.message);
    }
  }
  
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(versionInfo);
});

module.exports = router;

