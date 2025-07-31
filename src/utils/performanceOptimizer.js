/**
 * Performance optimization utilities for ultra-fast request matching
 */

// Pre-compiled regex cache - avoids creating regex objects on each request
const regexCache = new Map();

// Scenario pattern regexes - compiled once
const SCENARIO_PATTERNS = {
  // Performance & Network patterns
  slowResponse: /^slow-response-(\d+)$/,
  requestTimeout: /^request-timeout-after-(\d+)$/,
  connectionReset: /^connection-reset$/,
  connectionRefused: /^connection-refused$/,
  networkUnreachable: /^network-unreachable$/,
  dnsFailure: /^dns-resolution-failure$/,
  
  // HTTP Error patterns
  error400: /^error-400-bad-request$/,
  error401: /^error-401-unauthorized$/,
  error403: /^error-403-forbidden$/,
  error404: /^error-404-not-found$/,
  error405: /^error-405-method-not-allowed$/,
  error409: /^error-409-conflict$/,
  error422: /^error-422-validation-failed$/,
  error429: /^error-429-too-many-requests$/,
  error500: /^error-500-internal$/,
  error502: /^error-502-bad-gateway$/,
  error503: /^error-503-service-unavailable$/,
  error504: /^error-504-gateway-timeout$/,
  error507: /^error-507-insufficient-storage$/,
  
  // Authentication patterns
  validAuthBearer: /^valid-auth-bearer$/,
  validAuthBasic: /^valid-auth-basic$/,
  validAuthApiKey: /^valid-auth-apikey-(.+)$/,
  validAuthJwt: /^valid-auth-jwt$/,
  validAuthOauth2: /^valid-auth-oauth2$/,
  invalidAuthBearer: /^invalid-auth-bearer$/,
  invalidAuthBearerExpired: /^invalid-auth-bearer-expired$/,
  invalidAuthBearerMalformed: /^invalid-auth-bearer-malformed$/,
  invalidAuthBasic: /^invalid-auth-basic$/,
  invalidAuthBasicFormat: /^invalid-auth-basic-format$/,
  invalidAuthApiKey: /^invalid-auth-apikey-(.+)$/,
  invalidAuthJwt: /^invalid-auth-jwt$/,
  invalidAuthJwtExpired: /^invalid-auth-jwt-expired$/,
  invalidAuthOauth2: /^invalid-auth-oauth2$/,
  missingAuthBearer: /^missing-auth-bearer$/,
  missingAuthBasic: /^missing-auth-basic$/,
  missingAuthApiKey: /^missing-auth-apikey-(.+)$/,
  missingAuthJwt: /^missing-auth-jwt$/,
  missingAuthOauth2: /^missing-auth-oauth2$/,
  
  // Data response patterns
  partialData: /^partial-data-(\d+)$/,
  dataMissingField: /^data-missing-field-(.+)$/,
  dataNullField: /^data-null-field-(.+)$/,
  dataWrongTypeField: /^data-wrong-type-field-(.+)$/,
  dataCorrupted: /^data-corrupted-json$/,
  dataExtraFields: /^data-extra-fields$/,
  dataTruncated: /^data-truncated-(\d+)$/
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
 * Supports multiple scenarios separated by commas
 */
function parseScenarioHeader(scenarioHeader) {
  if (!scenarioHeader) return null;

  // Split by comma to support multiple scenarios
  const scenarios = scenarioHeader.split(',').map(s => s.trim());
  const results = [];

  for (const scenario of scenarios) {
    const result = parseSingleScenario(scenario);
    if (result) {
      results.push(result);
    }
  }

  // Return single result or array of results
  if (results.length === 0) return null;
  if (results.length === 1) return results[0];
  return { type: 'multiple', scenarios: results };
}

/**
 * Parse a single scenario pattern
 */
function parseSingleScenario(scenario) {
  // Performance & Network patterns
  if (scenario.startsWith('slow-response-')) {
    const match = scenario.match(SCENARIO_PATTERNS.slowResponse);
    if (match) {
      const ms = parseInt(match[1]);
      if (ms >= 0 && ms <= 60000) {
        return { type: 'slow', value: ms };
      }
    }
  }
  
  if (scenario.startsWith('request-timeout-after-')) {
    const match = scenario.match(SCENARIO_PATTERNS.requestTimeout);
    if (match) {
      const ms = parseInt(match[1]);
      if (ms >= 0 && ms <= 60000) {
        return { type: 'timeout', value: ms, isRequestTimeout: true };
      }
    }
  }
  
  // Network error patterns
  if (scenario === 'connection-reset') {
    return { type: 'network-error', value: 'ECONNRESET' };
  }
  if (scenario === 'connection-refused') {
    return { type: 'network-error', value: 'ECONNREFUSED' };
  }
  if (scenario === 'network-unreachable') {
    return { type: 'network-error', value: 'ENETUNREACH' };
  }
  if (scenario === 'dns-resolution-failure') {
    return { type: 'network-error', value: 'ENOTFOUND' };
  }
  
  // HTTP Error patterns with specific names
  const errorPatterns = [
    { pattern: SCENARIO_PATTERNS.error400, code: 400 },
    { pattern: SCENARIO_PATTERNS.error401, code: 401 },
    { pattern: SCENARIO_PATTERNS.error403, code: 403 },
    { pattern: SCENARIO_PATTERNS.error404, code: 404 },
    { pattern: SCENARIO_PATTERNS.error405, code: 405 },
    { pattern: SCENARIO_PATTERNS.error409, code: 409 },
    { pattern: SCENARIO_PATTERNS.error422, code: 422 },
    { pattern: SCENARIO_PATTERNS.error429, code: 429 },
    { pattern: SCENARIO_PATTERNS.error500, code: 500 },
    { pattern: SCENARIO_PATTERNS.error502, code: 502 },
    { pattern: SCENARIO_PATTERNS.error503, code: 503 },
    { pattern: SCENARIO_PATTERNS.error504, code: 504 },
    { pattern: SCENARIO_PATTERNS.error507, code: 507 }
  ];
  
  for (const { pattern, code } of errorPatterns) {
    if (pattern.test(scenario)) {
      return { type: 'error', value: code };
    }
  }
  
  // Authentication patterns
  if (SCENARIO_PATTERNS.validAuthBearer.test(scenario)) {
    return { type: 'auth', subtype: 'valid', method: 'bearer' };
  }
  if (SCENARIO_PATTERNS.validAuthBasic.test(scenario)) {
    return { type: 'auth', subtype: 'valid', method: 'basic' };
  }
  if (scenario.startsWith('valid-auth-apikey-')) {
    const match = scenario.match(SCENARIO_PATTERNS.validAuthApiKey);
    if (match) {
      return { type: 'auth', subtype: 'valid', method: 'apikey', header: match[1] };
    }
  }
  if (SCENARIO_PATTERNS.validAuthJwt.test(scenario)) {
    return { type: 'auth', subtype: 'valid', method: 'jwt' };
  }
  if (SCENARIO_PATTERNS.validAuthOauth2.test(scenario)) {
    return { type: 'auth', subtype: 'valid', method: 'oauth2' };
  }
  
  // Invalid auth patterns
  if (SCENARIO_PATTERNS.invalidAuthBearer.test(scenario)) {
    return { type: 'auth', subtype: 'invalid', method: 'bearer' };
  }
  if (SCENARIO_PATTERNS.invalidAuthBearerExpired.test(scenario)) {
    return { type: 'auth', subtype: 'invalid', method: 'bearer', reason: 'expired' };
  }
  if (SCENARIO_PATTERNS.invalidAuthBearerMalformed.test(scenario)) {
    return { type: 'auth', subtype: 'invalid', method: 'bearer', reason: 'malformed' };
  }
  if (SCENARIO_PATTERNS.invalidAuthBasic.test(scenario)) {
    return { type: 'auth', subtype: 'invalid', method: 'basic' };
  }
  if (SCENARIO_PATTERNS.invalidAuthBasicFormat.test(scenario)) {
    return { type: 'auth', subtype: 'invalid', method: 'basic', reason: 'format' };
  }
  if (scenario.startsWith('invalid-auth-apikey-')) {
    const match = scenario.match(SCENARIO_PATTERNS.invalidAuthApiKey);
    if (match) {
      return { type: 'auth', subtype: 'invalid', method: 'apikey', header: match[1] };
    }
  }
  if (SCENARIO_PATTERNS.invalidAuthJwt.test(scenario)) {
    return { type: 'auth', subtype: 'invalid', method: 'jwt' };
  }
  if (SCENARIO_PATTERNS.invalidAuthJwtExpired.test(scenario)) {
    return { type: 'auth', subtype: 'invalid', method: 'jwt', reason: 'expired' };
  }
  if (SCENARIO_PATTERNS.invalidAuthOauth2.test(scenario)) {
    return { type: 'auth', subtype: 'invalid', method: 'oauth2' };
  }
  
  // Missing auth patterns
  if (SCENARIO_PATTERNS.missingAuthBearer.test(scenario)) {
    return { type: 'auth', subtype: 'missing', method: 'bearer' };
  }
  if (SCENARIO_PATTERNS.missingAuthBasic.test(scenario)) {
    return { type: 'auth', subtype: 'missing', method: 'basic' };
  }
  if (scenario.startsWith('missing-auth-apikey-')) {
    const match = scenario.match(SCENARIO_PATTERNS.missingAuthApiKey);
    if (match) {
      return { type: 'auth', subtype: 'missing', method: 'apikey', header: match[1] };
    }
  }
  if (SCENARIO_PATTERNS.missingAuthJwt.test(scenario)) {
    return { type: 'auth', subtype: 'missing', method: 'jwt' };
  }
  if (SCENARIO_PATTERNS.missingAuthOauth2.test(scenario)) {
    return { type: 'auth', subtype: 'missing', method: 'oauth2' };
  }
  
  // Data response patterns
  if (scenario.startsWith('partial-data-')) {
    const match = scenario.match(SCENARIO_PATTERNS.partialData);
    if (match) {
      const percent = parseInt(match[1]);
      if (percent >= 0 && percent <= 100) {
        return { type: 'data', subtype: 'partial', percent };
      }
    }
  }
  
  if (scenario.startsWith('data-missing-field-')) {
    const match = scenario.match(SCENARIO_PATTERNS.dataMissingField);
    if (match) {
      return { type: 'data', subtype: 'missing-field', field: match[1] };
    }
  }
  
  if (scenario.startsWith('data-null-field-')) {
    const match = scenario.match(SCENARIO_PATTERNS.dataNullField);
    if (match) {
      return { type: 'data', subtype: 'null-field', field: match[1] };
    }
  }
  
  if (scenario.startsWith('data-wrong-type-field-')) {
    const match = scenario.match(SCENARIO_PATTERNS.dataWrongTypeField);
    if (match) {
      return { type: 'data', subtype: 'wrong-type', field: match[1] };
    }
  }
  
  if (SCENARIO_PATTERNS.dataCorrupted.test(scenario)) {
    return { type: 'data', subtype: 'corrupted' };
  }
  
  if (SCENARIO_PATTERNS.dataExtraFields.test(scenario)) {
    return { type: 'data', subtype: 'extra-fields' };
  }
  
  if (scenario.startsWith('data-truncated-')) {
    const match = scenario.match(SCENARIO_PATTERNS.dataTruncated);
    if (match) {
      const percent = parseInt(match[1]);
      if (percent >= 0 && percent <= 100) {
        return { type: 'data', subtype: 'truncated', percent };
      }
    }
  }

  return null;
}

/**
 * Get all available scenario patterns
 */
function getAllAvailableScenarios() {
  return {
    performance: [
      'slow-response-[ms]',
      'request-timeout-after-[ms]'
    ],
    network: [
      'connection-reset',
      'connection-refused',
      'network-unreachable',
      'dns-resolution-failure'
    ],
    errors: [
      'error-400-bad-request',
      'error-401-unauthorized',
      'error-403-forbidden',
      'error-404-not-found',
      'error-405-method-not-allowed',
      'error-409-conflict',
      'error-422-validation-failed',
      'error-429-too-many-requests',
      'error-500-internal',
      'error-502-bad-gateway',
      'error-503-service-unavailable',
      'error-504-gateway-timeout',
      'error-507-insufficient-storage'
    ],
    authentication: {
      valid: [
        'valid-auth-bearer',
        'valid-auth-basic',
        'valid-auth-apikey-[header-name]',
        'valid-auth-jwt',
        'valid-auth-oauth2'
      ],
      invalid: [
        'invalid-auth-bearer',
        'invalid-auth-bearer-expired',
        'invalid-auth-bearer-malformed',
        'invalid-auth-basic',
        'invalid-auth-basic-format',
        'invalid-auth-apikey-[header-name]',
        'invalid-auth-jwt',
        'invalid-auth-jwt-expired',
        'invalid-auth-oauth2'
      ],
      missing: [
        'missing-auth-bearer',
        'missing-auth-basic',
        'missing-auth-apikey-[header-name]',
        'missing-auth-jwt',
        'missing-auth-oauth2'
      ]
    },
    data: [
      'partial-data-[percent]',
      'data-missing-field-[field-name]',
      'data-null-field-[field-name]',
      'data-wrong-type-field-[field-name]',
      'data-corrupted-json',
      'data-extra-fields',
      'data-truncated-[percent]'
    ]
  };
}

module.exports = {
  getCachedRegex,
  extractPath,
  optimizeMapping,
  fastMatch,
  parseScenarioHeader,
  SCENARIO_PATTERNS,
  getAllAvailableScenarios
};