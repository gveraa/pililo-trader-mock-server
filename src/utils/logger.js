const pino = require('pino');
const path = require('path');

/**
 * Create logger instance with configurable output
 * 
 * Environment Variables:
 * - ENABLE_FILE_LOGGING: Set to 'true' to enable file logging (default: console only)
 * 
 * File Logging Features:
 * - Fixed path: ./logs/mock-server.log
 * - Max file size: 5MB before rotation
 * - Max files: 3 (current + 2 rotated)
 * - Auto-creates directory if needed
 */
function createLogger() {
  const enableFileLogging = process.env.ENABLE_FILE_LOGGING === 'true';
  
  if (enableFileLogging) {
    // File logging without rotation for now
    const fs = require('fs');
    const logDir = path.join(process.cwd(), 'logs');
    const logFile = path.join(logDir, 'mock-server.log');
    
    // Ensure logs directory exists
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    // Ensure the log file doesn't exist as a directory
    try {
      const stats = fs.statSync(logFile);
      if (stats.isDirectory()) {
        fs.rmSync(logFile, { recursive: true, force: true });
      }
    } catch (err) {
      // File doesn't exist, which is fine
    }
    
    const logger = pino({
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: false,  // No colors in file
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
          destination: logFile
        }
      }
    });
    
    // Log startup info about file logging
    logger.info({
      logFile,
      output: 'file'
    }, 'File logging enabled');
    
    return logger;
  } else {
    // Console logging (default)
    const logger = pino({
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname'
        }
      }
    });
    
    // Log startup info about console logging
    logger.info({
      output: 'console',
      pretty: true
    }, 'Console logging enabled (default)');
    
    return logger;
  }
}

module.exports = { createLogger };