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
    // File logging with rotation
    const logFile = path.join(process.cwd(), 'logs', 'mock-server.log');
    const destination = pino.destination({
      dest: logFile,
      maxLength: 5 * 1024 * 1024, // 5MB
      maxFiles: 3,
      mkdir: true // Create directory if it doesn't exist
    });
    
    const logger = pino({
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => {
          return { level: label };
        }
      }
    }, destination);
    
    // Log startup info about file logging
    logger.info({
      logFile,
      maxSize: '5MB',
      maxFiles: 3,
      rotation: true
    }, 'File logging enabled with rotation');
    
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