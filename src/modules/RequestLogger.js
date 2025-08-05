/**
 * Enhanced Request Logger with comprehensive diagnostic information
 * 
 * Logs all incoming requests with:
 * - Correlation IDs for request tracing
 * - Matched mock configurations
 * - Response details and timing
 * - Headers and body information
 * - Scenario processing details
 */

class RequestLogger {
  constructor(logger) {
    this.logger = logger.child({ module: 'RequestLogger' });
  }

  /**
   * Log incoming request with full diagnostic information
   * @param {Object} request - Fastify request object
   * @param {string} correlationId - Request correlation ID
   * @param {Object} scenario - Parsed scenario information
   */
  logIncomingRequest(request, correlationId, scenario = null) {
    const requestInfo = {
      correlationId,
      timestamp: new Date().toISOString(),
      method: request.method,
      url: request.url,
      path: this.extractPath(request.url),
      headers: this.sanitizeHeaders(request.headers),
      query: request.query,
      hasBody: this.hasRequestBody(request),
      bodySize: this.getBodySize(request),
      scenario: scenario ? this.formatScenario(scenario) : null,
      userAgent: request.headers['user-agent'],
      origin: request.headers['origin'],
      referer: request.headers['referer']
    };

    // Log with different levels based on scenario
    const logLevel = scenario?.type === 'error' ? 'warn' : 'info';
    const scenarioText = scenario ? ` [${this.formatScenario(scenario)}]` : '';
    
    this.logger[logLevel]({
      ...requestInfo,
      event: 'request_received'
    }, `→ [${correlationId}] ${request.method} ${request.url}${scenarioText}`);

    return requestInfo;
  }

  /**
   * Log successful mock match with detailed information
   * @param {string} correlationId - Request correlation ID
   * @param {Object} mapping - Matched mapping configuration
   * @param {Object} matchDetails - Details about the match
   */
  logMockMatch(correlationId, mapping, matchDetails) {
    // Build endpoint object in same format as /status endpoint
    const endpointObj = {
      id: mapping.id || mapping._mappingIndex,
      method: mapping.request.method || 'GET',
      path: mapping.request.urlPath || mapping.request.urlPathPattern,
      pathType: mapping.request.urlPath ? 'exact' : 'pattern',
      priority: mapping._priority || this.calculatePriority(mapping)
    };

    // Add headers if present
    if (mapping.request.headers) {
      endpointObj.headers = {};
      Object.entries(mapping.request.headers).forEach(([name, criteria]) => {
        if (typeof criteria === 'string') {
          endpointObj.headers[name] = { equals: criteria };
        } else {
          endpointObj.headers[name] = criteria;
        }
      });
    }

    // Add query parameters if present
    if (mapping.request.queryParameters) {
      endpointObj.queryParameters = mapping.request.queryParameters;
    }

    // Add body patterns if present
    if (mapping.request.bodyPatterns) {
      endpointObj.bodyPatterns = mapping.request.bodyPatterns;
    }

    // Add response status
    endpointObj.responseStatus = mapping.response?.status || 200;

    const matchInfo = {
      correlationId,
      event: 'mock_matched',
      matchedMapping: endpointObj,
      configName: mapping._configName,
      configFile: mapping._location,
      hasScenarioRestrictions: !!(mapping.allowedScenarios || mapping.forbiddenScenarios),
      matchDetails: {
        ...matchDetails,
        matchedBy: this.identifyMatchCriteria(mapping)
      }
    };

    this.logger.info(matchInfo, `✓ [${correlationId}] Matched: ${mapping._configName} (priority: ${endpointObj.priority})`);

    return matchInfo;
  }

  /**
   * Log response details
   * @param {string} correlationId - Request correlation ID
   * @param {Object} responseConfig - Response configuration
   * @param {number} processingTime - Time taken to process request
   */
  logResponse(correlationId, responseConfig, processingTime) {
    const totalTime = processingTime + (responseConfig.delay || 0);
    const responseInfo = {
      correlationId,
      event: 'response_sent',
      timestamp: new Date().toISOString(),
      status: responseConfig.status || 200,
      headers: responseConfig.headers || {},
      hasBody: !!(responseConfig.jsonBody || responseConfig.body || responseConfig.base64Body),
      bodyType: this.getBodyType(responseConfig),
      delay: responseConfig.delay || 0
    };

    const statusEmoji = responseInfo.status >= 500 ? '❌' : 
                       responseInfo.status >= 400 ? '⚠️' : '✅';
    
    this.logger.info(responseInfo, 
      `← [${correlationId}] ${statusEmoji} ${responseInfo.status} (${totalTime}ms)`);

    return responseInfo;
  }

  /**
   * Log scenario application details
   * @param {string} correlationId - Request correlation ID
   * @param {Object} scenario - Applied scenario
   * @param {Object} modifications - Response modifications made
   */
  logScenarioApplication(correlationId, scenario, modifications) {
    const scenarioInfo = {
      correlationId,
      event: 'scenario_applied',
      scenario: this.formatScenario(scenario),
      modifications: {
        statusChanged: !!modifications.status,
        headersAdded: Object.keys(modifications.headers || {}).length,
        bodyModified: !!modifications.body,
        delayAdded: !!modifications.delay
      }
    };

    this.logger.info(scenarioInfo, 
      `🎭 [${correlationId}] Applied scenario: ${scenarioInfo.scenario}`);

    return scenarioInfo;
  }


  // Private helper methods

  extractPath(url) {
    const queryIndex = url.indexOf('?');
    return queryIndex === -1 ? url : url.substring(0, queryIndex);
  }

  sanitizeHeaders(headers) {
    const sanitized = { ...headers };
    // Remove or mask sensitive headers
    const sensitiveHeaders = ['authorization', 'x-api-key', 'cookie'];
    sensitiveHeaders.forEach(header => {
      if (sanitized[header]) {
        sanitized[header] = '[REDACTED]';
      }
    });
    return sanitized;
  }

  hasRequestBody(request) {
    return !!(request.body && (
      typeof request.body === 'string' || 
      typeof request.body === 'object'
    ));
  }

  getBodySize(request) {
    if (!request.body) return 0;
    return typeof request.body === 'string' 
      ? request.body.length 
      : JSON.stringify(request.body).length;
  }

  getBodyType(responseConfig) {
    if (responseConfig.jsonBody) return 'json';
    if (responseConfig.body) return 'text';
    if (responseConfig.base64Body) return 'binary';
    return 'empty';
  }

  formatScenario(scenario) {
    if (typeof scenario === 'string') return scenario;
    if (scenario.type === 'multiple') {
      return scenario.scenarios.map(s => s.name || s.type).join(', ');
    }
    return scenario.name || scenario.type || 'unknown';
  }

  calculatePriority(mapping) {
    // Simplified priority calculation
    if (mapping.request.urlPath) return 1; // Exact path
    if (mapping.request.urlPathPattern) {
      const wildcards = (mapping.request.urlPathPattern.match(/\*/g) || []).length;
      return 100 + wildcards * 10;
    }
    return 1000; // Default
  }

  identifyMatchCriteria(mapping) {
    const criteria = [];
    if (mapping.request.method) criteria.push('method');
    if (mapping.request.urlPath) criteria.push('exact-path');
    if (mapping.request.urlPathPattern) criteria.push('path-pattern');
    if (mapping.request.headers) criteria.push('headers');
    if (mapping.request.query) criteria.push('query');
    return criteria;
  }
}

module.exports = RequestLogger;