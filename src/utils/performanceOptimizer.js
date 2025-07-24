/**
 * Performance optimization utilities for ultra-fast request matching
 */

// Pre-compiled regex cache - avoids creating regex objects on each request
const regexCache = new Map();

// Scenario pattern regexes - compiled once
const SCENARIO_PATTERNS = {
  timeout: /^timeout-(\d+)$/,
  slow: /^slow-(\d+)$/,
  error: /^error-(\d{3})$/
};

/**
 * Get or create cached regex
 */
function getCachedRegex(pattern) {
  let regex = regexCache.get(pattern);
  if (!regex) {
    regex = new RegExp(pattern);
    regexCache.set(pattern, regex);
  }
  return regex;
}

/**
 * Fast path extraction without query string
 */
function extractPath(url) {
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : url.substring(0, queryIndex);
}

/**
 * Optimize mapping for fast matching
 */
function optimizeMapping(mapping) {
  const optimized = {
    ...mapping,
    _optimized: true,
    _method: (mapping.request.method || 'GET').toUpperCase()
  };

  // Pre-compile URL pattern regex
  if (mapping.request.urlPathPattern) {
    optimized._urlPatternRegex = getCachedRegex(mapping.request.urlPathPattern);
  }

  // Pre-compile header regexes
  if (mapping.request.headers) {
    optimized._headerRegexes = {};
    for (const [name, criteria] of Object.entries(mapping.request.headers)) {
      if (criteria.matches) {
        optimized._headerRegexes[name.toLowerCase()] = getCachedRegex(criteria.matches);
      }
    }
  }

  // Pre-compile query param regexes
  if (mapping.request.queryParameters) {
    optimized._queryRegexes = {};
    for (const [name, criteria] of Object.entries(mapping.request.queryParameters)) {
      if (criteria.matches) {
        optimized._queryRegexes[name] = getCachedRegex(criteria.matches);
      }
    }
  }

  // Pre-compile body pattern regexes
  if (mapping.request.bodyPatterns) {
    optimized._bodyRegexes = [];
    for (const pattern of mapping.request.bodyPatterns) {
      if (pattern.matches) {
        optimized._bodyRegexes.push({
          ...pattern,
          _regex: getCachedRegex(pattern.matches)
        });
      }
    }
  }

  return optimized;
}

/**
 * Ultra-fast request matching with early exits
 */
function fastMatch(request, mapping, urlPath) {
  // 1. Method check (fastest)
  if (mapping._method !== request.method) {
    return false;
  }

  // 2. Path check (second fastest)
  if (mapping.request.urlPath) {
    if (urlPath !== mapping.request.urlPath) {
      return false;
    }
  } else if (mapping._urlPatternRegex) {
    if (!mapping._urlPatternRegex.test(urlPath)) {
      return false;
    }
  }

  // 3. Headers check (if needed)
  if (mapping.request.headers) {
    const headers = request.headers;
    for (const [name, criteria] of Object.entries(mapping.request.headers)) {
      const lowerName = name.toLowerCase();
      const value = headers[lowerName];

      if (criteria.absent === true) {
        if (value !== undefined) return false;
        continue;
      }

      if (!value) return false;

      if (criteria.equals !== undefined) {
        if (value !== criteria.equals) return false;
      } else if (criteria.equalTo !== undefined) {
        if (value !== criteria.equalTo) return false;
      } else if (criteria.matches !== undefined) {
        const regex = mapping._headerRegexes[lowerName];
        if (!regex.test(value)) return false;
      }
    }
  }

  // 4. Query params (if needed)
  if (mapping.request.queryParameters) {
    const query = request.query;
    for (const [name, criteria] of Object.entries(mapping.request.queryParameters)) {
      const value = query[name];
      
      if (!value) return false;

      if (criteria.equals !== undefined) {
        if (value !== criteria.equals) return false;
      } else if (criteria.equalTo !== undefined) {
        if (value !== criteria.equalTo) return false;
      } else if (criteria.matches !== undefined) {
        const regex = mapping._queryRegexes[name];
        if (!regex.test(value)) return false;
      }
    }
  }

  // 5. Body patterns (most expensive, do last)
  if (mapping.request.bodyPatterns && request.body) {
    // Cache stringified body to avoid multiple JSON.stringify
    let bodyStr;
    
    for (const pattern of mapping.request.bodyPatterns) {
      if (pattern.contains !== undefined) {
        bodyStr = bodyStr || (typeof request.body === 'string' ? request.body : JSON.stringify(request.body));
        if (!bodyStr.includes(pattern.contains)) return false;
      } else if (pattern.matches !== undefined) {
        bodyStr = bodyStr || (typeof request.body === 'string' ? request.body : JSON.stringify(request.body));
        // Use pre-compiled regex from optimization
        const optimizedPattern = mapping._bodyRegexes.find(p => p.matches === pattern.matches);
        if (!optimizedPattern._regex.test(bodyStr)) return false;
      } else if (pattern.equalToJson !== undefined) {
        // For now, keep simple deep equal - can optimize later
        if (!simpleDeepEqual(request.body, pattern.equalToJson)) return false;
      }
      // Skip JSONPath for ultra-fast mode - too expensive
    }
  }

  return true;
}

/**
 * Simple deep equal optimized for common cases
 */
function simpleDeepEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  
  for (const key of keysA) {
    if (!simpleDeepEqual(a[key], b[key])) return false;
  }
  
  return true;
}

/**
 * Parse dynamic scenario header with cached regexes
 */
function parseScenarioHeader(scenarioHeader) {
  if (!scenarioHeader) return null;

  // Check timeout pattern
  if (scenarioHeader.startsWith('timeout-')) {
    const match = scenarioHeader.match(SCENARIO_PATTERNS.timeout);
    if (match) {
      const seconds = parseInt(match[1]);
      if (seconds >= 0 && seconds <= 60) {
        return { type: 'timeout', value: seconds * 1000 };
      }
    }
  }
  
  // Check slow pattern
  else if (scenarioHeader.startsWith('slow-')) {
    const match = scenarioHeader.match(SCENARIO_PATTERNS.slow);
    if (match) {
      const ms = parseInt(match[1]);
      if (ms >= 0 && ms <= 60000) {
        return { type: 'slow', value: ms };
      }
    }
  }
  
  // Check error pattern
  else if (scenarioHeader.startsWith('error-')) {
    const match = scenarioHeader.match(SCENARIO_PATTERNS.error);
    if (match) {
      const code = parseInt(match[1]);
      if (code >= 400 && code <= 599) {
        return { type: 'error', value: code };
      }
    }
  }

  return null;
}

module.exports = {
  getCachedRegex,
  extractPath,
  optimizeMapping,
  fastMatch,
  parseScenarioHeader,
  SCENARIO_PATTERNS
};