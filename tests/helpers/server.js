const MockServer = require('../../src/MockServer.js');
const path = require('path');
const __dirname = __dirname;

// Create a simple logger for tests
const testLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {}
};

/**
 * Create a test server instance with test fixtures
 * @param {Object} options - Server configuration options
 * @returns {Promise<Object>} Server instance and utilities
 */
async function createTestServer(options = {}) {
  const {
    port = 0, // Use random available port
    useTestFixtures = true,
    configDir = useTestFixtures ? path.join(__dirname, '../fixtures/mock-configs') : 'mocks'
  } = options;

  const mockServer = new MockServer(testLogger);

  // Initialize with test configuration
  await mockServer.initialize({
    configDir,
    stopOnError: false
  });

  // Create Fastify server
  const server = await mockServer.createServer();

  // Register all configurations
  const configs = mockServer.configManager.getAllConfigurations();

  for (const config of configs) {
    if (config.type === 'ws') {
      mockServer.registerWebSocketHandlers(server, config);
    } else if (config.type === 'api') {
      mockServer.registerApiHandlers(server, config);
    }
  }

  // Sort API mappings and register built-in endpoints
  mockServer.sortApiMappingsByPriority();
  mockServer.registerBuiltInEndpoints(server);
  mockServer.registerCatchAllRoute(server);

  // Start the server
  const address = await server.listen({ port, host: '127.0.0.1' });
  const serverPort = server.server.address().port;
  const baseUrl = `http://127.0.0.1:${serverPort}`;
  const wsUrl = `ws://127.0.0.1:${serverPort}`;

  // Track for cleanup
  global.trackServer(server);

  // Start scheduled messages for WebSocket configs
  configs.filter(c => c.type === 'ws').forEach(config => {
    mockServer.schedulerService.startScheduledMessages(config, (configName, message, options) => {
      return mockServer.connectionManager.broadcast(configName, message, options);
    });
  });

  return {
    server,
    mockServer,
    port: serverPort,
    baseUrl,
    wsUrl,
    address,
    configs,
    async close() {
      await server.close();
    }
  };
}

/**
 * Get a free port number
 * @returns {Promise<number>} Available port number
 */
async function getFreePort() {
  const net = require('net');

  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

module.exports = {
  createTestServer,
  getFreePort
};