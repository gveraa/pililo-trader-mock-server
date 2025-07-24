const jsonpath = require('jsonpath');

class ApiRequestMatcher {
  constructor(logger) {
    this.logger = logger.child({ module: 'ApiRequestMatcher' });
  }

  /**
   * Check if request matches all criteria
   * @param {Object} request - Fastify request object
   * @param {Object} criteria - Request matching criteria from config
   * @returns {boolean} True if request matches all criteria
   */
  async matches(request, criteria) {
    try {
      // Check method
      if (criteria.method && request.method !== criteria.method) {
        this.logger.warn({
          expected: criteria.method,
          actual: request.method
        }, 'Method mismatch');
        return false;
      }

      // Check URL path (without query string)
      if (criteria.urlPath) {
        const urlPath = request.url.split('?')[0];
        if (urlPath !== criteria.urlPath) {
          this.logger.warn({
            expected: criteria.urlPath,
            actual: urlPath
          }, 'URL path mismatch');
          return false;
        }
      }

      // Check URL pattern (without query string)
      if (criteria.urlPathPattern) {
        const urlPath = request.url.split('?')[0];
        const pattern = new RegExp(criteria.urlPathPattern);
        if (!pattern.test(urlPath)) {
          this.logger.warn({
            pattern: criteria.urlPathPattern,
            actual: urlPath
          }, 'URL pattern mismatch');
          return false;
        }
      }

      // Check headers
      if (criteria.headers) {
        for (const [headerName, headerCriteria] of Object.entries(criteria.headers)) {
          const headerValue = request.headers[headerName.toLowerCase()];
          
          // Handle 'absent' criteria
          if (headerCriteria.absent === true) {
            if (headerValue !== undefined) {
              this.logger.warn({
                header: headerName,
                value: headerValue
              }, 'Header should be absent');
              return false;
            }
            continue;
          }
          
          if (!headerValue) {
            this.logger.warn({
              header: headerName
            }, 'Required header missing');
            return false;
          }

          if (!this.matchValue(headerValue, headerCriteria)) {
            this.logger.warn({
              header: headerName,
              value: headerValue,
              criteria: headerCriteria
            }, 'Header value mismatch');
            return false;
          }
        }
      }

      // Check query parameters
      if (criteria.queryParameters) {
        for (const [paramName, paramCriteria] of Object.entries(criteria.queryParameters)) {
          const paramValue = request.query[paramName];
          
          if (!paramValue) {
            this.logger.warn({
              param: paramName
            }, 'Required query parameter missing');
            return false;
          }

          if (!this.matchValue(paramValue, paramCriteria)) {
            this.logger.warn({
              param: paramName,
              value: paramValue,
              criteria: paramCriteria
            }, 'Query parameter value mismatch');
            return false;
          }
        }
      }

      // Check body patterns
      if (criteria.bodyPatterns && request.body) {
        for (const pattern of criteria.bodyPatterns) {
          if (!this.matchBodyPattern(request.body, pattern)) {
            this.logger.warn({
              pattern
            }, 'Body pattern mismatch');
            return false;
          }
        }
      }

      return true;
    } catch (error) {
      this.logger.error({
        error: error.message,
        criteria
      }, 'Error matching request');
      return false;
    }
  }

  /**
   * Match a value against criteria
   * @param {string} value - Value to match
   * @param {Object} criteria - Matching criteria
   * @returns {boolean} True if value matches criteria
   */
  matchValue(value, criteria) {
    // Support both 'equals' and 'equalTo' for compatibility
    if (criteria.equals !== undefined) {
      return value === criteria.equals;
    }
    
    if (criteria.equalTo !== undefined) {
      return value === criteria.equalTo;
    }

    if (criteria.matches !== undefined) {
      const pattern = new RegExp(criteria.matches);
      return pattern.test(value);
    }
    
    // Check for 'absent' criteria
    if (criteria.absent === true) {
      return value === undefined || value === null;
    }

    // If no criteria specified, consider it a match
    return true;
  }

  /**
   * Match request body against a pattern
   * @param {*} body - Request body
   * @param {Object} pattern - Body pattern to match
   * @returns {boolean} True if body matches pattern
   */
  matchBodyPattern(body, pattern) {
    try {
      // String contains
      if (pattern.contains !== undefined) {
        const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
        return bodyStr.includes(pattern.contains);
      }

      // Regex matches
      if (pattern.matches !== undefined) {
        const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
        const regex = new RegExp(pattern.matches);
        return regex.test(bodyStr);
      }

      // JSON equality
      if (pattern.equalToJson !== undefined) {
        return this.deepEqual(body, pattern.equalToJson);
      }

      // JSONPath matching
      if (pattern.matchesJsonPath) {
        return this.matchJsonPath(body, pattern.matchesJsonPath);
      }

      return true;
    } catch (error) {
      this.logger.error({
        error: error.message,
        pattern
      }, 'Error matching body pattern');
      return false;
    }
  }

  /**
   * Match using JSONPath
   * @param {*} data - Data to search
   * @param {Object} jsonPathCriteria - JSONPath criteria
   * @returns {boolean} True if matches
   */
  matchJsonPath(data, jsonPathCriteria) {
    try {
      const results = jsonpath.query(data, jsonPathCriteria.expression);
      
      if (results.length === 0) {
        return false;
      }

      // Check if any result matches the criteria
      return results.some(result => {
        if (jsonPathCriteria.equals !== undefined) {
          return this.deepEqual(result, jsonPathCriteria.equals);
        }

        if (jsonPathCriteria.contains !== undefined) {
          const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
          return resultStr.includes(jsonPathCriteria.contains);
        }

        if (jsonPathCriteria.matches !== undefined) {
          const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
          const regex = new RegExp(jsonPathCriteria.matches);
          return regex.test(resultStr);
        }

        // If no value criteria, just check that path exists
        return true;
      });
    } catch (error) {
      this.logger.error({
        error: error.message,
        expression: jsonPathCriteria.expression
      }, 'JSONPath evaluation error');
      return false;
    }
  }

  /**
   * Deep equality check
   * @param {*} a - First value
   * @param {*} b - Second value
   * @returns {boolean} True if deeply equal
   */
  deepEqual(a, b) {
    if (a === b) return true;
    
    if (a == null || b == null) return false;
    
    if (typeof a !== typeof b) return false;
    
    if (typeof a !== 'object') return false;
    
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    
    if (keysA.length !== keysB.length) return false;
    
    for (const key of keysA) {
      if (!keysB.includes(key)) return false;
      if (!this.deepEqual(a[key], b[key])) return false;
    }
    
    return true;
  }
}

module.exports = ApiRequestMatcher;