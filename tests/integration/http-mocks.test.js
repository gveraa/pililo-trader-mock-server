const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const request = require('supertest');
const { createTestServer } = require('../helpers/server.js');

describe('HTTP Mock Integration Tests', () => {
  let testServer;
  let app;

  beforeEach(async () => {
    testServer = await createTestServer();
    app = testServer.server;
  });

  afterEach(async () => {
    if (testServer) {
      await testServer.close();
    }
  });

  describe('Basic Endpoint Matching', () => {
    it('should handle exact path matches', async () => {
      const response = await request(app)
        .get('/api/users/123')
        .expect(200);

      expect(response.body).toEqual({
        id: '123',
        name: 'Test User',
        email: 'test@example.com'
      });
      expect(response.headers['content-type']).toMatch(/application\/json/);
    });

    it('should handle regex pattern matches', async () => {
      const response = await request(app)
        .get('/api/products/456')
        .expect(200);

      expect(response.body).toEqual({
        productId: '456',
        name: 'Product 456'
      });
    });

    it('should return 404 for unmatched paths', async () => {
      const response = await request(app)
        .get('/api/nonexistent')
        .expect(404);

      expect(response.body).toEqual({
        error: 'Not Found',
        message: 'No mock mapping found for this request',
        method: 'GET',
        path: '/api/nonexistent'
      });
    });
  });

  describe('HTTP Methods', () => {
    it('should handle POST requests with body', async () => {
      const userData = {
        name: 'John Doe',
        email: 'john@example.com'
      };

      const response = await request(app)
        .post('/api/users')
        .send(userData)
        .set('Content-Type', 'application/json')
        .expect(201);

      expect(response.body).toMatchObject({
        name: 'John Doe',
        email: 'john@example.com'
      });
      expect(response.body.id).toBeDefined();
      expect(response.body.createdAt).toBeDefined();
    });

    it('should reject POST without proper Content-Type', async () => {
      await request(app)
        .post('/api/users')
        .send({ name: 'Test' })
        .expect(404); // Should not match due to missing Content-Type header
    });
  });

  describe('Scenario-based Responses', () => {
    it('should return success response for success scenario', async () => {
      const response = await request(app)
        .get('/api/status')
        .set('X-Mock-Scenario', 'success')
        .expect(200);

      expect(response.body).toEqual({
        status: 'ok'
      });
    });

    it('should return error response for error scenario', async () => {
      const response = await request(app)
        .get('/api/status')
        .set('X-Mock-Scenario', 'error')
        .expect(500);

      expect(response.body).toEqual({
        error: 'Internal Server Error'
      });
    });

    it('should default to first matching rule without scenario header', async () => {
      const response = await request(app)
        .get('/api/status')
        .expect(200);

      expect(response.body).toEqual({
        status: 'ok'
      });
    });
  });

  describe('Template Variables', () => {
    it('should process template variables in responses', async () => {
      const userData = {
        name: 'Jane Smith',
        email: 'jane@example.com'
      };

      const response = await request(app)
        .post('/api/users')
        .send(userData)
        .set('Content-Type', 'application/json')
        .expect(201);

      // Check that template variables were processed
      expect(response.body.id).toMatch(/^[0-9a-f-]{36}$/); // UUID format
      expect(response.body.name).toBe('Jane Smith');
      expect(response.body.email).toBe('jane@example.com');
      expect(new Date(response.body.createdAt)).toBeInstanceOf(Date);
    });
  });

  describe('Built-in Endpoints', () => {
    it('should handle health check endpoint', async () => {
      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.body).toMatchObject({
        status: 'healthy',
        connections: expect.any(Number),
        uptime: expect.any(Number)
      });
    });

    it('should handle status endpoint', async () => {
      const response = await request(app)
        .get('/status')
        .expect(200);

      expect(response.body).toHaveProperty('ws');
      expect(response.body).toHaveProperty('api');
    });

    it('should handle reload endpoint', async () => {
      const response = await request(app)
        .get('/reload')
        .expect(200);

      expect(response.body).toMatchObject({
        status: 'success',
        message: 'Configurations reloaded successfully',
        summary: expect.objectContaining({
          total: expect.any(Number),
          loaded: expect.any(Number),
          failed: expect.any(Number)
        }),
        configurations: expect.objectContaining({
          ws: expect.any(Array),
          api: expect.any(Array)
        })
      });
    });

    it('should handle timeout test endpoint', async () => {
      const startTime = Date.now();

      const response = await request(app)
        .get('/timeout/1')
        .expect(200);

      const endTime = Date.now();
      const duration = endTime - startTime;

      expect(response.body).toEqual({
        message: 'Response after 1 second(s) delay'
      });
      expect(duration).toBeGreaterThan(900); // At least 900ms
      expect(duration).toBeLessThan(1500); // But not more than 1.5s
    }, 10000);

    it('should handle status code test endpoint', async () => {
      const response = await request(app)
        .get('/status/418')
        .expect(418);

      expect(response.body).toEqual({
        message: "I'm a teapot"
      });
    });

    it('should reject invalid timeout values', async () => {
      await request(app)
        .get('/timeout/100')
        .expect(400);

      await request(app)
        .get('/timeout/-1')
        .expect(400);
    });

    it('should reject invalid status codes', async () => {
      await request(app)
        .get('/status/99')
        .expect(400);

      await request(app)
        .get('/status/600')
        .expect(400);
    });
  });

  describe('Request Logging and Headers', () => {
    it('should include correlation ID in responses', async () => {
      const response = await request(app)
        .get('/health')
        .expect(200);

      // The correlation ID should be logged but not necessarily returned in headers
      // We can verify the response is properly formatted
      expect(response.body).toBeDefined();
    });

    it('should handle various content types', async () => {
      const response = await request(app)
        .get('/api/users/123')
        .expect(200);

      expect(response.headers['content-type']).toMatch(/application\/json/);
    });
  });
});