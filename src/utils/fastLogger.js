/**
 * Performance-optimized logging utilities
 */

// Pre-allocated counter for correlation IDs (faster than Date.now + random)
let requestCounter = 0;

/**
 * Generate correlation ID using counter (much faster than Date.now + Math.random)
 */
function generateCorrelationId(prefix = 'req') {
  return `${prefix}-${++requestCounter}`;
}

/**
 * Efficiently preview a message without double JSON.stringify
 */
function getMessagePreview(message, maxLength = 50) {
  if (typeof message === 'string') {
    return message.length > maxLength 
      ? message.substring(0, maxLength) + '...'
      : message;
  }
  
  // For objects, stringify once and cache if needed
  try {
    const str = JSON.stringify(message);
    return str.length > maxLength 
      ? str.substring(0, maxLength) + '...'
      : str;
  } catch (e) {
    return '[Object]';
  }
}

/**
 * Create structured log data (lets Pino optimize serialization)
 */
function createRequestLog(method, url, correlationId, scenario) {
  return {
    type: 'request',
    correlationId,
    method,
    url,
    scenario: scenario || undefined
  };
}

function createResponseLog(method, url, correlationId, status) {
  return {
    type: 'response',
    correlationId,
    method,
    url,
    status
  };
}

module.exports = {
  generateCorrelationId,
  getMessagePreview,
  createRequestLog,
  createResponseLog
};