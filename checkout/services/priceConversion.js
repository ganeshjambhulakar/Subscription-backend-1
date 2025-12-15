const axios = require('axios');

// Cache for exchange rates (refresh every 1 minute)
let rateCache = {
  data: null,
  timestamp: null,
  ttl: 60 * 1000 // 1 minute
};

// Fallback rates for local development (approximate)
const FALLBACK_RATES = {
  ETH: 250000, // ₹250,000 per ETH
  USDT: 83,    // ₹83 per USDT
  MATIC: 85    // ₹85 per MATIC
};

/**
 * Fetch live crypto prices from CoinGecko API
 */
async function fetchCoinGeckoRates() {
  try {
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: {
        ids: 'ethereum,tether,matic-network',
        vs_currencies: 'inr'
      },
      timeout: 5000
    });

    return {
      ETH: response.data.ethereum?.inr || FALLBACK_RATES.ETH,
      USDT: response.data.tether?.inr || FALLBACK_RATES.USDT,
      MATIC: response.data['matic-network']?.inr || FALLBACK_RATES.MATIC,
      source: 'coingecko',
      timestamp: Date.now()
    };
  } catch (error) {
    console.warn('[PriceConversion] CoinGecko API error:', error.message);
    return null;
  }
}

/**
 * Get exchange rate for a crypto coin
 */
async function getExchangeRate(cryptoCoin = 'ETH') {
  const coin = cryptoCoin.toUpperCase();
  
  // Check cache
  if (rateCache.data && rateCache.timestamp) {
    const age = Date.now() - rateCache.timestamp;
    if (age < rateCache.ttl) {
      return {
        rate: rateCache.data[coin] || FALLBACK_RATES[coin],
        source: rateCache.data.source || 'fallback',
        cached: true
      };
    }
  }

  // Fetch fresh rates
  const rates = await fetchCoinGeckoRates();
  
  if (rates) {
    rateCache.data = rates;
    rateCache.timestamp = Date.now();
    return {
      rate: rates[coin] || FALLBACK_RATES[coin],
      source: rates.source,
      cached: false
    };
  }

  // Fallback to hardcoded rates
  return {
    rate: FALLBACK_RATES[coin] || FALLBACK_RATES.ETH,
    source: 'fallback',
    cached: false
  };
}

/**
 * Convert INR amount to crypto amount
 * @param {number} inrAmount - Amount in Indian Rupees
 * @param {string} cryptoCoin - Crypto coin symbol (ETH, USDT, MATIC)
 * @returns {Promise<Object>} Conversion result
 */
async function convertInrToCrypto(inrAmount, cryptoCoin = 'ETH') {
  // Validation
  if (!inrAmount || inrAmount <= 0) {
    throw new Error('INR amount must be greater than 0');
  }

  if (!cryptoCoin || typeof cryptoCoin !== 'string') {
    throw new Error('Crypto coin symbol is required');
  }

  const coin = cryptoCoin.toUpperCase();
  const supportedCoins = ['ETH', 'USDT', 'MATIC'];
  
  if (!supportedCoins.includes(coin)) {
    throw new Error(`Unsupported crypto coin: ${coin}. Supported: ${supportedCoins.join(', ')}`);
  }

  // Get exchange rate
  const { rate, source, cached } = await getExchangeRate(coin);

  // Calculate crypto amount
  const cryptoAmount = inrAmount / rate;

  // Validate result
  if (cryptoAmount <= 0) {
    throw new Error('Calculated crypto amount is invalid');
  }

  return {
    inrAmount: Number(inrAmount.toFixed(2)),
    cryptoCoin: coin,
    cryptoAmount: cryptoAmount.toString(),
    exchangeRate: rate,
    priceSource: source,
    cached,
    timestamp: Date.now()
  };
}

/**
 * Convert crypto amount to INR
 * @param {number} cryptoAmount - Amount in crypto
 * @param {string} cryptoCoin - Crypto coin symbol
 * @returns {Promise<Object>} Conversion result
 */
async function convertCryptoToInr(cryptoAmount, cryptoCoin = 'ETH') {
  const { rate, source } = await getExchangeRate(cryptoCoin);
  const inrAmount = cryptoAmount * rate;

  return {
    cryptoAmount: Number(cryptoAmount.toFixed(8)),
    cryptoCoin: cryptoCoin.toUpperCase(),
    inrAmount: Number(inrAmount.toFixed(2)),
    exchangeRate: rate,
    priceSource: source,
    timestamp: Date.now()
  };
}

/**
 * Get all supported exchange rates
 */
async function getAllRates() {
  const rates = await fetchCoinGeckoRates();
  
  if (rates) {
    rateCache.data = rates;
    rateCache.timestamp = Date.now();
    return rates;
  }

  return {
    ETH: FALLBACK_RATES.ETH,
    USDT: FALLBACK_RATES.USDT,
    MATIC: FALLBACK_RATES.MATIC,
    source: 'fallback',
    timestamp: Date.now()
  };
}

module.exports = {
  convertInrToCrypto,
  convertCryptoToInr,
  getExchangeRate,
  getAllRates,
  FALLBACK_RATES
};



