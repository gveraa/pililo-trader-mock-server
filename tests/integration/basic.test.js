import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MockServer = require('../../src/MockServer');

describe('Basic Integration Tests', () => {
  let mockServer;
  let server;
  let port;

  const testLogger = {
    info: (...args) => console.log('INFO:', ...args),
    error: (...args) => console.error('ERROR:', ...args),
    warn: (...args) => console.warn('WARN:', ...args),
    debug: (...args) => console.log('DEBUG:', ...args),
    child: () => testLogger
  };

  beforeAll(async () => {
    // Create mock server instance
    mockServer = new MockServer(testLogger);

    // Initialize with test fixtures
    const configDir = 'tests/fixtures/mock-configs';
    console.log('Initializing with config dir:', configDir);
    try {
      const result = await mockServer.initialize({
        configDir,
        stopOnError: false
      });
      console.log('Initialize result:', result?.length, 'configs loaded');
    } catch (error) {
      console.error('Initialize error:', error.message);
      throw error;
    }

    // Create and start server
    server = await mockServer.createServer();

    // Register configurations
    const configs = mockServer.configManager.getAllConfigurations();
    console.log('Loaded configs:', configs.length, configs.map(c => c.name));

    for (const config of configs) {
      if (config.type === 'ws') {
        mockServer.registerWebSocketHandlers(server, config);
      } else if (config.type === 'api') {
        mockServer.registerApiHandlers(server, config);
        console.log('Registered API config:', config.name, 'with', config.mappings?.length, 'mappings');
      }
    }

    mockServer.sortApiMappingsByPriority();
    mockServer.registerBuiltInEndpoints(server);
    mockServer.registerCatchAllRoute(server);

    // Start server on random port
    const address = await server.listen({ port: 0, host: '127.0.0.1' });
    port = server.server.address().port;

    // Start scheduled messages
    configs.filter(c => c.type === 'ws').forEach(config => {
      mockServer.schedulerService.startScheduledMessages(config, (configName, message, options) => {
        return mockServer.connectionManager.broadcast(configName, message, options);
      });
    });
  }, 10000);

  afterAll(async () => {
    if (server) {
      await server.close();
    }
  });

  describe('Health Endpoints', () => {
    it('should respond to health check', async () => {
      const response = await request(server.server)
        .get('/health')
        .expect(200);

      expect(response.body).toMatchObject({
        status: 'healthy',
        uptime: expect.any(Number)
      });
    });

    it('should respond to status endpoint', async () => {
      const response = await request(server.server)
        .get('/status')
        .expect(200);

      expect(response.body).toHaveProperty('ws');
      expect(response.body).toHaveProperty('api');
    });

    it('should handle reload endpoint', async () => {
      const response = await request(server.server)
        .get('/reload')
        .expect(200);

      expect(response.body).toMatchObject({
        status: 'success',
        message: 'Configurations reloaded successfully'
      });
    });
  });

  describe('Test Mock Endpoints', () => {
    it('should handle test API endpoint', async () => {
      const response = await request(server.server)
        .get('/api/users/123')
        .expect(200);

      expect(response.body).toEqual({
        id: '123',
        name: 'Test User',
        email: 'test@example.com'
      });
    });

    it('should handle POST with template variables', async () => {
      const userData = {
        name: 'John Doe',
        email: 'john@example.com'
      };

      const response = await request(server.server)
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

    it('should handle pattern matching', async () => {
      const response = await request(server.server)
        .get('/api/products/456')
        .expect(200);

      expect(response.body).toEqual({
        productId: '456',
        name: 'Product 456'
      });
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for unmatched routes', async () => {
      const response = await request(server.server)
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
});