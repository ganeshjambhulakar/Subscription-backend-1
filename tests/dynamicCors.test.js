const request = require('supertest');
const express = require('express');
const { Pool } = require('pg');
const dynamicCors = require('../middleware/dynamicCors');

// Mock database pool
jest.mock('pg', () => {
  const mockPool = {
    query: jest.fn(),
  };
  return { Pool: jest.fn(() => mockPool) };
});

describe('Dynamic CORS Middleware', () => {
  let app;
  let pool;
  
  beforeEach(() => {
    app = express();
    app.use(express.json());
    
    // Attach middleware the same way the real app does (via app.use),
    // so OPTIONS preflight requests also pass through dynamicCors.
    app.use('/api/test', dynamicCors);
    
    // Create test routes
    app.get('/api/test', (req, res) => {
      res.json({ success: true, appInfo: req.appInfo });
    });
    
    app.post('/api/test', (req, res) => {
      res.json({ success: true, appInfo: req.appInfo });
    });
    
    pool = new Pool();
  });
  
  afterEach(() => {
    jest.clearAllMocks();
  });
  
  describe('Scenario 1: Valid request with matching origin and API key', () => {
    it('should allow request and set CORS headers', async () => {
      const mockApp = {
        app_id: 'app_123',
        vendor_address: '0x123',
        allowed_domains: ['shopabc.com'],
        verified_domains: [],
        active: true
      };
      
      pool.query.mockResolvedValueOnce({ rows: [mockApp] });
      
      const response = await request(app)
        .get('/api/test')
        .set('Origin', 'https://shopabc.com')
        .set('X-API-Key', 'valid_api_key');
      
      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('https://shopabc.com');
      expect(response.headers['access-control-allow-credentials']).toBe('true');
      expect(response.body.success).toBe(true);
      expect(response.body.appInfo.appId).toBe('app_123');
    });
  });
  
  describe('Scenario 2: Invalid API key', () => {
    it('should return 403 with error message', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });
      
      const response = await request(app)
        .get('/api/test')
        .set('Origin', 'https://shopabc.com')
        .set('X-API-Key', 'invalid_api_key');
      
      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Unauthorized');
      expect(response.body.message).toContain('invalid API key');
      
      // Verify failed attempt was logged
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO cors_failed_attempts'),
        expect.any(Array)
      );
    });
  });
  
  describe('Scenario 3: Valid API key but origin not in allowed domains', () => {
    it('should return 403 with domain error', async () => {
      const mockApp = {
        app_id: 'app_123',
        vendor_address: '0x123',
        allowed_domains: ['shopabc.com'],
        verified_domains: [],
        active: true
      };
      
      pool.query.mockResolvedValueOnce({ rows: [mockApp] });
      
      const response = await request(app)
        .get('/api/test')
        .set('Origin', 'https://unauthorized.com')
        .set('X-API-Key', 'valid_api_key');
      
      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Unauthorized');
      expect(response.body.message).toContain('Unauthorized domain');
      expect(response.body.details).toContain('not in the allowed domains list');
    });
  });
  
  describe('Scenario 4: Missing Origin header', () => {
    it('should return 403 for external routes', async () => {
      const response = await request(app)
        .get('/api/test')
        .set('X-API-Key', 'valid_api_key');
      
      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Unauthorized');
      expect(response.body.details).toContain('Origin header is required');
    });
  });
  
  describe('Scenario 5: Missing API key', () => {
    it('should return 403 with error message', async () => {
      const response = await request(app)
        .get('/api/test')
        .set('Origin', 'https://shopabc.com');
      
      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Unauthorized');
      expect(response.body.details).toContain('X-API-Key header is required');
    });
  });
  
  describe('Scenario 6: Inactive app', () => {
    it('should return 403 for inactive app', async () => {
      const mockApp = {
        app_id: 'app_123',
        vendor_address: '0x123',
        allowed_domains: ['shopabc.com'],
        verified_domains: [],
        active: false
      };
      
      pool.query.mockResolvedValueOnce({ rows: [mockApp] });
      
      const response = await request(app)
        .get('/api/test')
        .set('Origin', 'https://shopabc.com')
        .set('X-API-Key', 'valid_api_key');
      
      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Unauthorized');
      expect(response.body.message).toContain('inactive');
    });
  });
  
  describe('Scenario 7: OPTIONS preflight request', () => {
    it('should handle OPTIONS with valid origin and API key', async () => {
      const mockApp = {
        app_id: 'app_123',
        vendor_address: '0x123',
        allowed_domains: ['shopabc.com'],
        verified_domains: [],
        active: true
      };
      
      pool.query.mockResolvedValueOnce({ rows: [mockApp] });
      
      const response = await request(app)
        .options('/api/test')
        .set('Origin', 'https://shopabc.com')
        .set('X-API-Key', 'valid_api_key');
      
      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('https://shopabc.com');
      expect(response.headers['access-control-allow-methods']).toContain('GET');
      expect(response.headers['access-control-allow-methods']).toContain('POST');
    });
    
    it('should handle OPTIONS with invalid origin', async () => {
      const mockApp = {
        app_id: 'app_123',
        vendor_address: '0x123',
        allowed_domains: ['shopabc.com'],
        verified_domains: [],
        active: true
      };
      
      pool.query.mockResolvedValueOnce({ rows: [mockApp] });
      
      const response = await request(app)
        .options('/api/test')
        .set('Origin', 'https://unauthorized.com')
        .set('X-API-Key', 'valid_api_key');
      
      // OPTIONS should still return 200 but with default CORS headers
      expect(response.status).toBe(200);
    });
  });
  
  describe('Scenario 8: Wildcard domain matching', () => {
    it('should match subdomains with wildcard', async () => {
      const mockApp = {
        app_id: 'app_123',
        vendor_address: '0x123',
        allowed_domains: ['*.shopabc.com'],
        verified_domains: [],
        active: true
      };
      
      pool.query.mockResolvedValueOnce({ rows: [mockApp] });
      
      const response = await request(app)
        .get('/api/test')
        .set('Origin', 'https://sub.shopabc.com')
        .set('X-API-Key', 'valid_api_key');
      
      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('https://sub.shopabc.com');
    });
  });
  
  describe('Scenario 9: Multiple allowed domains', () => {
    it('should allow request from any allowed domain', async () => {
      const mockApp = {
        app_id: 'app_123',
        vendor_address: '0x123',
        allowed_domains: ['shopabc.com', 'ecommerce.xyz', 'store.example.com'],
        verified_domains: [],
        active: true
      };
      
      pool.query.mockResolvedValueOnce({ rows: [mockApp] });
      
      const response = await request(app)
        .get('/api/test')
        .set('Origin', 'https://ecommerce.xyz')
        .set('X-API-Key', 'valid_api_key');
      
      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('https://ecommerce.xyz');
    });
  });
  
  describe('Scenario 10: Database error handling', () => {
    it('should return 500 on database error', async () => {
      pool.query.mockRejectedValueOnce(new Error('Database connection failed'));
      
      const response = await request(app)
        .get('/api/test')
        .set('Origin', 'https://shopabc.com')
        .set('X-API-Key', 'valid_api_key');
      
      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Internal Server Error');
    });
  });
  
  describe('Scenario 11: Internal routes without Origin', () => {
    it('should allow internal routes without Origin header', async () => {
      // Create internal route
      const internalApp = express();
      internalApp.use(express.json());
      internalApp.get('/api/admin/test', dynamicCors, (req, res) => {
        res.json({ success: true });
      });
      
      const response = await request(internalApp)
        .get('/api/admin/test')
        .set('X-API-Key', 'valid_api_key');
      
      // Should not require Origin for internal routes
      expect(response.status).toBe(200);
    });
  });
  
  describe('Scenario 12: Domain extraction from various origin formats', () => {
    it('should extract domain from https://origin', async () => {
      const mockApp = {
        app_id: 'app_123',
        vendor_address: '0x123',
        allowed_domains: ['shopabc.com'],
        verified_domains: [],
        active: true
      };
      
      pool.query.mockResolvedValueOnce({ rows: [mockApp] });
      
      const response = await request(app)
        .get('/api/test')
        .set('Origin', 'https://shopabc.com')
        .set('X-API-Key', 'valid_api_key');
      
      expect(response.status).toBe(200);
    });
    
    it('should extract domain from http://origin', async () => {
      const mockApp = {
        app_id: 'app_123',
        vendor_address: '0x123',
        allowed_domains: ['shopabc.com'],
        verified_domains: [],
        active: true
      };
      
      pool.query.mockResolvedValueOnce({ rows: [mockApp] });
      
      const response = await request(app)
        .get('/api/test')
        .set('Origin', 'http://shopabc.com')
        .set('X-API-Key', 'valid_api_key');
      
      expect(response.status).toBe(200);
    });
  });
});

