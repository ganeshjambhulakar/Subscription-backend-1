/**
 * Build script to minify and version CDN assets
 * Generates minified versions of wallet.js with version numbers
 */

const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

const CDN_DIR = path.join(__dirname, '../../integration-service/cdn');
const VERSION_FILE = path.join(CDN_DIR, 'version.json');

// Current version (semantic versioning)
const CURRENT_VERSION = process.env.CDN_VERSION || '1.0.0';

async function minifyWallet() {
  try {
    const walletPath = path.join(CDN_DIR, 'wallet.js');
    
    if (!fs.existsSync(walletPath)) {
      console.error('❌ wallet.js not found at:', walletPath);
      process.exit(1);
    }

    console.log('📦 Building minified wallet.js...');
    
    // Read source file
    const sourceCode = fs.readFileSync(walletPath, 'utf8');
    
    // Minify
    const result = await minify(sourceCode, {
      compress: {
        drop_console: false, // Keep console.log for debugging
        passes: 2
      },
      mangle: {
        reserved: ['ethers', 'window', 'document', 'console'] // Don't mangle these
      },
      format: {
        comments: false
      }
    });

    if (result.error) {
      throw result.error;
    }

    // Create dist directory if it doesn't exist
    const distDir = path.join(CDN_DIR, 'dist');
    if (!fs.existsSync(distDir)) {
      fs.mkdirSync(distDir, { recursive: true });
    }

    // Write minified version
    const minifiedPath = path.join(distDir, `wallet.${CURRENT_VERSION}.min.js`);
    fs.writeFileSync(minifiedPath, result.code);
    
    // Also create a latest symlink/copy for convenience
    const latestPath = path.join(distDir, 'wallet.latest.min.js');
    fs.writeFileSync(latestPath, result.code);

    // Update version file
    const versionInfo = {
      version: CURRENT_VERSION,
      wallet: {
        version: CURRENT_VERSION,
        minified: `wallet.${CURRENT_VERSION}.min.js`,
        latest: 'wallet.latest.min.js',
        size: {
          original: sourceCode.length,
          minified: result.code.length,
          reduction: `${((1 - result.code.length / sourceCode.length) * 100).toFixed(2)}%`
        },
        built: new Date().toISOString()
      }
    };

    // Read existing version file if it exists
    let existingVersions = {};
    if (fs.existsSync(VERSION_FILE)) {
      try {
        existingVersions = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
      } catch (e) {
        console.warn('Could not read existing version file:', e.message);
      }
    }

    // Merge with existing versions
    const allVersions = {
      ...existingVersions,
      ...versionInfo,
      versions: {
        ...(existingVersions.versions || {}),
        [CURRENT_VERSION]: {
          wallet: versionInfo.wallet,
          built: versionInfo.wallet.built
        }
      }
    };

    fs.writeFileSync(VERSION_FILE, JSON.stringify(allVersions, null, 2));

    console.log('✅ Minified wallet.js created:');
    console.log(`   📄 ${minifiedPath}`);
    console.log(`   📄 ${latestPath}`);
    console.log(`   📊 Size: ${(result.code.length / 1024).toFixed(2)} KB (${versionInfo.wallet.size.reduction} reduction)`);
    console.log(`   🔢 Version: ${CURRENT_VERSION}`);
    
    return {
      version: CURRENT_VERSION,
      minifiedPath,
      latestPath,
      size: result.code.length
    };
  } catch (error) {
    console.error('❌ Error minifying wallet.js:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  minifyWallet().then(() => {
    console.log('✅ Build complete!');
    process.exit(0);
  }).catch(error => {
    console.error('❌ Build failed:', error);
    process.exit(1);
  });
}

module.exports = { minifyWallet, CURRENT_VERSION };

