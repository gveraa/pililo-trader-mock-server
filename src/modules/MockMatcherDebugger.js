/**
 * Mock Matcher Debugger - Detailed analysis of request matching logic
 * 
 * Provides comprehensive debugging information about:
 * - Why requests matched or didn't match specific mocks
 * - Priority evaluation and ranking
 * - Detailed matching criteria analysis
 * - Performance metrics for matching process
 */

class MockMatcherDebugger {
  constructor(logger) {
    this.logger = logger.child({ module: 'MockMatcherDebugger' });
  }

  /**
   * Debug a complete matching session for a request
   * @param {string} correlationId - Request correlation ID
   * @param {Object} request - Fastify request object
   * @param {Array} mappings - All available mappings to test
   * @param {string} urlPath - Extracted URL path
   */
  debugMatchingSession(correlationId, request, mappings, urlPath) {

    const session = {
      correlationId,
      timestamp: new Date().toISOString(),
      request: {
        method: request.method,
        url: request.url,
        path: urlPath,
        headers: this.sanitizeHeaders(request.headers),
        query: request.query
      },
      totalMappings: mappings.length,
      matchAttempts: [],
      finalResult: null,
      performance: {
        startTime: Date.now(),
        endTime: null,
        totalTime: null
      }
    };

    // Test each mapping and record results
    mappings.forEach((mapping, index) => {
      const attempt = this.debugSingleMatch(request, mapping, urlPath, index);
      session.matchAttempts.push(attempt);
    });

    // Find the winning match (highest priority successful match)
    const successfulMatches = session.matchAttempts.filter(attempt => attempt.matched);
    const pathMatches = session.matchAttempts.filter(attempt => attempt.checks.path.passed);
    
    if (successfulMatches.length > 0) {
      const winner = successfulMatches.reduce((best, current) => 
        current.endpoint.priority < best.endpoint.priority ? current : best);
      session.finalResult = {
        matched: true,
        winner: winner.endpoint,
        totalSuccessfulMatches: successfulMatches.length,
        alternativeMatches: successfulMatches.filter(m => m !== winner).map(m => ({
          endpoint: m.endpoint,
          configName: m.configName
        }))
      };
    } else {
      // Check if we had path matches but other conditions failed
      const partialMatches = pathMatches.filter(attempt => !attempt.matched);
      
      // Separate method mismatches from other condition failures
      const methodMismatches = partialMatches.filter(attempt => !attempt.checks.method.passed);
      const otherMismatches = partialMatches.filter(attempt => attempt.checks.method.passed);
      
      session.finalResult = {
        matched: false,
        failureReasons: this.analyzeFailureReasons(session.matchAttempts),
        pathMatches: partialMatches.length,
        methodMismatches: methodMismatches.length,
        partialMatches: partialMatches.map(attempt => ({
          endpoint: attempt.endpoint,
          configName: attempt.configName,
          failedOn: this.getFirstFailedCheck(attempt)
        }))
      };
    }

    session.performance.endTime = Date.now();
    session.performance.totalTime = session.performance.endTime - session.performance.startTime;

    // Log summary
    this.logMatchingSummary(session);

    return session;
  }

  /**
   * Debug a single mapping match attempt
   * @param {Object} request - Request object
   * @param {Object} mapping - Mapping to test
   * @param {string} urlPath - URL path
   * @param {number} index - Mapping index for identification
   */
  debugSingleMatch(request, mapping, urlPath, index) {
    // Build endpoint object in same format as /status endpoint
    const endpointObj = {
      id: mapping.id || mapping._mappingIndex || index,
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

    const attempt = {
      endpoint: endpointObj,
      configName: mapping._configName,
      configFile: mapping._location,
      matched: false,
      checks: {
        method: { required: null, actual: null, passed: false },
        path: { required: null, actual: null, passed: false },
        headers: { required: null, actual: null, passed: false, details: [] },
        query: { required: null, actual: null, passed: false, details: [] },
        body: { required: null, actual: null, passed: false }
      },
      failureReason: null,
      performance: Date.now()
    };

    try {
      // Always check both method and path for better diagnostics
      const requiredMethod = (mapping.request.method || 'GET').toUpperCase();
      const actualMethod = request.method.toUpperCase();
      attempt.checks.method = {
        required: requiredMethod,
        actual: actualMethod,
        passed: requiredMethod === 'ANY' || requiredMethod === actualMethod
      };

      // Check path regardless of method result
      attempt.checks.path = this.debugPathMatch(mapping.request, urlPath);

      // Now determine if we should continue or fail
      if (!attempt.checks.method.passed) {
        attempt.failureReason = `Method mismatch: expected ${requiredMethod}, got ${actualMethod}`;
        // If path matches but method doesn't, we'll catch this in the summary
        return attempt;
      }

      if (!attempt.checks.path.passed) {
        attempt.failureReason = attempt.checks.path.failureReason;
        return attempt;
      }

      // Check headers
      attempt.checks.headers = this.debugHeadersMatch(mapping.request.headers, request.headers);
      if (!attempt.checks.headers.passed) {
        attempt.failureReason = `Header mismatch: ${attempt.checks.headers.failureReason}`;
        return attempt;
      }

      // Check query parameters
      attempt.checks.query = this.debugQueryMatch(mapping.request.query, request.query);
      if (!attempt.checks.query.passed) {
        attempt.failureReason = `Query mismatch: ${attempt.checks.query.failureReason}`;
        return attempt;
      }

      // Check body if required
      attempt.checks.body = this.debugBodyMatch(mapping.request.body, request.body);
      if (!attempt.checks.body.passed) {
        attempt.failureReason = `Body mismatch: ${attempt.checks.body.failureReason}`;
        return attempt;
      }

      // All checks passed
      attempt.matched = true;

    } catch (error) {
      attempt.failureReason = `Error during matching: ${error.message}`;
      this.logger.error({
        correlationId: request.correlationId,
        endpoint: attempt.endpoint,
        error: error.message
      }, 'Error in match debugging');
    } finally {
      attempt.performance = Date.now() - attempt.performance;
    }

    return attempt;
  }

  /**
   * Debug path matching logic
   */
  debugPathMatch(requestConfig, actualPath) {
    const result = {
      passed: false,
      required: null,
      actual: actualPath,
      matchType: null,
      failureReason: null
    };

    // Exact path match
    if (requestConfig.urlPath) {
      result.required = requestConfig.urlPath;
      result.matchType = 'exact';
      result.passed = requestConfig.urlPath === actualPath;
      if (!result.passed) {
        result.failureReason = `Exact path mismatch: expected '${requestConfig.urlPath}', got '${actualPath}'`;
      }
      return result;
    }

    // Pattern match
    if (requestConfig.urlPathPattern) {
      result.required = requestConfig.urlPathPattern;
      result.matchType = 'pattern';
      try {
        const regex = new RegExp(requestConfig.urlPathPattern);
        result.passed = regex.test(actualPath);
        if (!result.passed) {
          result.failureReason = `Pattern mismatch: '${actualPath}' does not match pattern '${requestConfig.urlPathPattern}'`;
        }
      } catch (error) {
        result.failureReason = `Invalid pattern '${requestConfig.urlPathPattern}': ${error.message}`;
      }
      return result;
    }

    // No path requirement - matches all
    result.passed = true;
    result.matchType = 'any';
    return result;
  }

  /**
   * Debug headers matching logic
   */
  debugHeadersMatch(requiredHeaders, actualHeaders) {
    const result = {
      passed: true,
      required: requiredHeaders || {},
      actual: this.sanitizeHeaders(actualHeaders),
      details: [],
      failureReason: null
    };

    if (!requiredHeaders) {
      return result;
    }

    for (const [headerName, headerRequirement] of Object.entries(requiredHeaders)) {
      const headerCheck = {
        name: headerName,
        required: headerRequirement,
        actual: actualHeaders[headerName.toLowerCase()],
        passed: false
      };

      if (typeof headerRequirement === 'string') {
        // Simple string match
        headerCheck.passed = actualHeaders[headerName.toLowerCase()] === headerRequirement;
        headerCheck.matchType = 'exact';
      } else if (headerRequirement.equals) {
        // Exact match
        headerCheck.passed = actualHeaders[headerName.toLowerCase()] === headerRequirement.equals;
        headerCheck.matchType = 'equals';
      } else if (headerRequirement.matches) {
        // Regex match
        headerCheck.matchType = 'regex';
        try {
          const regex = new RegExp(headerRequirement.matches);
          headerCheck.passed = regex.test(actualHeaders[headerName.toLowerCase()] || '');
        } catch (error) {
          headerCheck.passed = false;
          headerCheck.error = `Invalid regex: ${error.message}`;
        }
      } else if (headerRequirement.contains) {
        // Contains match
        headerCheck.matchType = 'contains';
        const actualValue = actualHeaders[headerName.toLowerCase()] || '';
        headerCheck.passed = actualValue.includes(headerRequirement.contains);
      }

      result.details.push(headerCheck);

      if (!headerCheck.passed) {
        result.passed = false;
        result.failureReason = `Header '${headerName}' failed: expected ${JSON.stringify(headerRequirement)}, got '${headerCheck.actual}'`;
        break;
      }
    }

    return result;
  }

  /**
   * Debug query parameters matching
   */
  debugQueryMatch(requiredQuery, actualQuery) {
    const result = {
      passed: true,
      required: requiredQuery || {},
      actual: actualQuery || {},
      details: [],
      failureReason: null
    };

    if (!requiredQuery) {
      return result;
    }

    for (const [paramName, paramRequirement] of Object.entries(requiredQuery)) {
      const paramCheck = {
        name: paramName,
        required: paramRequirement,
        actual: actualQuery[paramName],
        passed: false
      };

      if (typeof paramRequirement === 'string') {
        paramCheck.passed = actualQuery[paramName] === paramRequirement;
        paramCheck.matchType = 'exact';
      } else if (paramRequirement.equals) {
        paramCheck.passed = actualQuery[paramName] === paramRequirement.equals;
        paramCheck.matchType = 'equals';
      } else if (paramRequirement.matches) {
        paramCheck.matchType = 'regex';
        try {
          const regex = new RegExp(paramRequirement.matches);
          paramCheck.passed = regex.test(actualQuery[paramName] || '');
        } catch (error) {
          paramCheck.passed = false;
          paramCheck.error = `Invalid regex: ${error.message}`;
        }
      }

      result.details.push(paramCheck);

      if (!paramCheck.passed) {
        result.passed = false;
        result.failureReason = `Query param '${paramName}' failed: expected ${JSON.stringify(paramRequirement)}, got '${paramCheck.actual}'`;
        break;
      }
    }

    return result;
  }

  /**
   * Debug body matching logic (simplified)
   */
  debugBodyMatch(requiredBody, actualBody) {
    const result = {
      passed: true,
      required: requiredBody,
      actual: actualBody ? '[PRESENT]' : '[EMPTY]',
      failureReason: null
    };

    // For now, just check if body is required vs present
    if (requiredBody && !actualBody) {
      result.passed = false;
      result.failureReason = 'Body required but not provided';
    }

    return result;
  }

  /**
   * Analyze common failure reasons across all attempts
   */
  analyzeFailureReasons(attempts) {
    const reasons = {};
    attempts.forEach(attempt => {
      if (attempt.failureReason) {
        const category = this.categorizeFailure(attempt.failureReason);
        reasons[category] = (reasons[category] || 0) + 1;
      }
    });

    return {
      categories: reasons,
      mostCommon: Object.keys(reasons).reduce((a, b) => reasons[a] > reasons[b] ? a : b, 'unknown'),
      suggestions: this.generateSuggestions(reasons)
    };
  }

  /**
   * Categorize failure reasons for analysis
   */
  categorizeFailure(reason) {
    if (reason.includes('Method mismatch')) return 'method';
    if (reason.includes('path mismatch') || reason.includes('Pattern mismatch')) return 'path';
    if (reason.includes('Header')) return 'headers';
    if (reason.includes('Query')) return 'query';
    if (reason.includes('Body')) return 'body';
    return 'other';
  }

  /**
   * Generate helpful suggestions based on failure patterns
   */
  generateSuggestions(failureReasons) {
    const suggestions = [];

    if (failureReasons.method) {
      suggestions.push('Check if the HTTP method in your mock configuration matches the request method');
    }
    if (failureReasons.path) {
      suggestions.push('Verify the URL path or pattern in your mock configuration. Consider using urlPathPattern for flexible matching');
    }
    if (failureReasons.headers) {
      suggestions.push('Check required headers in your mock configuration. Ensure header names match exactly (case-insensitive)');
    }
    if (failureReasons.query) {
      suggestions.push('Verify query parameter requirements in your mock configuration');
    }

    return suggestions;
  }

  /**
   * Calculate mapping priority for debugging
   */
  calculatePriority(mapping) {
    if (mapping._priority) return mapping._priority;
    
    // Simplified priority calculation
    if (mapping.request.urlPath) return 1;
    if (mapping.request.urlPathPattern) {
      const wildcards = (mapping.request.urlPathPattern.match(/\*/g) || []).length;
      return 100 + wildcards * 10;
    }
    return 1000;
  }

  /**
   * Get the first failed check from an attempt
   */
  getFirstFailedCheck(attempt) {
    const checks = ['method', 'path', 'headers', 'query', 'body'];
    for (const checkName of checks) {
      if (!attempt.checks[checkName].passed) {
        return {
          check: checkName,
          reason: attempt.checks[checkName].failureReason || attempt.failureReason
        };
      }
    }
    return { check: 'unknown', reason: 'Unknown failure' };
  }

  /**
   * Log matching session summary
   */
  logMatchingSummary(session) {
    const { finalResult, matchAttempts, performance } = session;
    
    if (finalResult.matched) {
      this.logger.info({
        correlationId: session.correlationId,
        matchedEndpoint: finalResult.winner,
        matchingAlternatives: finalResult.alternativeMatches?.length || 0
      }, `🔍 [${session.correlationId}] Match found: ${finalResult.winner.id} (${matchAttempts.length} mappings tested in ${performance.totalTime}ms)`);
    } else {
      // Check if we had partial matches (path matched but other conditions failed)
      if (finalResult.pathMatches > 0) {
        const partialInfo = finalResult.partialMatches.map(pm => {
          const endpointStr = `${pm.endpoint.method} ${pm.endpoint.path}`;
          return `${pm.configName}:${endpointStr} (failed on ${pm.failedOn.check}: ${pm.failedOn.reason})`;
        });
        
        // Check if ALL partial matches failed on method (meaning wrong HTTP method)
        const allFailedOnMethod = finalResult.partialMatches.every(pm => pm.failedOn.check === 'method');
        
        if (allFailedOnMethod) {
          // All endpoints with this path require different methods
          const availableMethods = finalResult.partialMatches
            .map(pm => pm.endpoint.method)
            .filter((value, index, self) => self.indexOf(value) === index); // unique methods
          
          this.logger.warn({
            correlationId: session.correlationId,
            pathMatches: finalResult.pathMatches,
            availableMethods: availableMethods,
            partialMatches: finalResult.partialMatches
          }, `⚠️ [${session.correlationId}] Path exists but wrong method! Path ${session.request.url} exists with methods: [${availableMethods.join(', ')}], but not with ${session.request.method}`);
        } else {
          this.logger.warn({
            correlationId: session.correlationId,
            pathMatches: finalResult.pathMatches,
            partialMatches: finalResult.partialMatches
          }, `⚠️ [${session.correlationId}] Path exists but conditions failed! Found ${finalResult.pathMatches} partial matches: ${partialInfo.join(', ')}`);
        }
      } else {
        this.logger.warn({
          correlationId: session.correlationId,
          suggestions: finalResult.failureReasons.suggestions
        }, `❌ [${session.correlationId}] No match found (${matchAttempts.length} mappings tested, ${finalResult.failureReasons.mostCommon} most common failure)`);
      }
    }
  }

  // Private helper methods

  sanitizeHeaders(headers) {
    const sanitized = { ...headers };
    const sensitiveHeaders = ['authorization', 'x-api-key', 'cookie'];
    sensitiveHeaders.forEach(header => {
      if (sanitized[header]) {
        sanitized[header] = '[REDACTED]';
      }
    });
    return sanitized;
  }
}

module.exports = MockMatcherDebugger;