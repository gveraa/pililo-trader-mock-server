const MockServer = require('./MockServer');
const { createLogger } = require('./utils/logger');

const logger = createLogger();

// Main execution
async function main() {
  const mockServer = new MockServer(logger);

  try {
    logger.info('Starting Mock Server...');
    
    // Initialize the mock server system
    await mockServer.initialize({
      configDir: process.env.MOCKS_DIR || 'mocks'
    });

    // Start all configured servers
    await mockServer.startAll();

    // Setup graceful shutdown
    const gracefulShutdown = async (signal) => {
      logger.info({ signal }, 'Received shutdown signal');
      
      try {
        await mockServer.stopAll();
        logger.info('Graceful shutdown completed');
        process.exit(0);
      } catch (error) {
        logger.error({ error: error.message }, 'Error during shutdown');
        process.exit(1);
      }
    };

    // Register shutdown handlers
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    // Setup periodic cleanup (optional)
    if (process.env.ENABLE_CLEANUP === 'true') {
      setInterval(() => {
        mockServer.cleanup({
          closeStaleConnections: true,
          maxIdleTime: parseInt(process.env.MAX_IDLE_TIME) || 300000
        });
      }, 60000); // Run every minute
    }

    // Log runtime info periodically (optional)
    if (process.env.LOG_RUNTIME_INFO === 'true') {
      setInterval(() => {
        const info = mockServer.getRuntimeInfo();
        logger.info({
          runtime: info
        }, 'Runtime information');
      }, 30000); // Every 30 seconds
    }

  } catch (error) {
    logger.error({ error: error.message }, 'Failed to start application');
    process.exit(1);
  }
}

// Export for testing
module.exports = { MockServer };

// Run if called directly
if (require.main === module) {
  main();
}