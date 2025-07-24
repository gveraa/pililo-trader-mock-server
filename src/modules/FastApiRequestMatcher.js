/**
 * Ultra-fast API request matcher optimized for performance
 * 
 * Key optimizations:
 * - Pre-compiled regex patterns cached at startup
 * - Early exit on first mismatch
 * - Minimal object allocations
 * - No logging in hot path (unless debug mode)
 * - Optimized string operations
 */

const { fastMatch } = require('../utils/performanceOptimizer');

class FastApiRequestMatcher {
  constructor(logger) {
    this.logger = logger.child({ module: 'FastApiRequestMatcher' });
    this.debugMode = logger.level === 'debug' || logger.level === 'trace';
  }

  /**
   * Ultra-fast request matching
   * @param {Object} request - Fastify request object
   * @param {Object} mapping - Optimized mapping object
   * @param {string} urlPath - Pre-extracted URL path (no query string)
   * @returns {boolean} True if matches
   */
  matches(request, mapping, urlPath) {
    try {
      return fastMatch(request, mapping, urlPath);
    } catch (error) {
      // Only log errors, not mismatches
      if (this.debugMode) {
        this.logger.error({
          error: error.message,
          path: urlPath
        }, 'Error in fast matcher');
      }
      return false;
    }
  }

  /**
   * Get match details for logging (only called after successful match)
   */
  getMatchDetails(request, mapping) {
    return {
      method: request.method,
      path: request.url,
      matchedPath: mapping.request.urlPath || mapping.request.urlPathPattern,
      priority: mapping._priority,
      mappingId: mapping.id || mapping._mappingIndex,
      configName: mapping._configName,
      scenario: mapping.request.headers?.['X-Mock-Scenario']?.equals || 
               mapping.request.headers?.['X-Mock-Scenario']?.matches
    };
  }
}

module.exports = FastApiRequestMatcher;