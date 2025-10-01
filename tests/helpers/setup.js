import { beforeAll, afterAll, afterEach } from 'vitest';
import path from 'path';

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.ENABLE_FILE_LOGGING = 'false';
process.env.LOG_LEVEL = 'error'; // Only show errors during tests

// Track active servers and connections for cleanup
global.activeServers = new Set();
global.activeConnections = new Set();

// Helper to track servers
global.trackServer = (server) => {
  global.activeServers.add(server);
  return server;
};

// Helper to track WebSocket connections
global.trackConnection = (connection) => {
  global.activeConnections.add(connection);
  return connection;
};

// Cleanup after each test
afterEach(async () => {
  // Close all WebSocket connections
  for (const connection of global.activeConnections) {
    if (connection.readyState === connection.OPEN) {
      connection.close();
    }
  }
  global.activeConnections.clear();

  // Close all servers
  for (const server of global.activeServers) {
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
  }
  global.activeServers.clear();
});

// Final cleanup
afterAll(async () => {
  // Force close any remaining connections
  await new Promise(resolve => setTimeout(resolve, 100));
});