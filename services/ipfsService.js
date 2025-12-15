// Use dynamic import for IPFS client (ESM module)
let create = null;

let ipfsClient = null;

/**
 * Initialize IPFS client
 */
async function initialize() {
  const ipfsUrl = process.env.IPFS_URL || 'http://ipfs:5001';
  
  try {
    // Dynamic import for ESM module
    if (!create) {
      const ipfsModule = await import('ipfs-http-client');
      create = ipfsModule.create;
    }
    
    ipfsClient = create({
      url: ipfsUrl
    });
    console.log('✅ IPFS service initialized');
  } catch (error) {
    console.error('Failed to initialize IPFS client:', error);
    console.log('IPFS service will be unavailable');
  }
}

/**
 * Upload metadata to IPFS
 */
async function uploadMetadata(metadata) {
  if (!ipfsClient) {
    await initialize();
  }
  
  if (!ipfsClient) {
    throw new Error('IPFS client not available');
  }
  
  try {
    const metadataString = JSON.stringify(metadata);
    const result = await ipfsClient.add(metadataString);
    const cid = result.cid.toString();
    return `ipfs://${cid}`;
  } catch (error) {
    console.error('Error uploading to IPFS:', error);
    throw error;
  }
}

/**
 * Get metadata from IPFS
 */
async function getMetadata(ipfsUri) {
  if (!ipfsClient) {
    await initialize();
  }
  
  if (!ipfsClient) {
    throw new Error('IPFS client not available');
  }
  
  try {
    const cid = ipfsUri.replace('ipfs://', '');
    const chunks = [];
    
    for await (const chunk of ipfsClient.cat(cid)) {
      chunks.push(chunk);
    }
    
    const data = Buffer.concat(chunks).toString();
    return JSON.parse(data);
  } catch (error) {
    console.error('Error fetching from IPFS:', error);
    throw error;
  }
}

// Initialize on module load (async)
initialize().catch(err => {
  console.log('IPFS initialization deferred - will initialize on first use');
});

module.exports = {
  uploadMetadata,
  getMetadata,
  initialize
};

