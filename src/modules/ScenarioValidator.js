/**
 * Scenario Validator - Validates X-Mock-Scenario header syntax and provides suggestions
 * 
 * Features:
 * - Validates X-Mock-Scenario header syntax against known patterns
 * - Provides detailed error messages and suggestions
 * - Lists all available scenarios with examples
 * - Checks parameter ranges and formats
 * - Supports multiple scenario validation (comma-separated)
 */

class ScenarioValidator {
  constructor(logger) {
    this.logger = logger.child({ module: 'ScenarioValidator' });

    // Import scenario patterns from performance optimizer
    this.SCENARIO_PATTERNS = {
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
  }

  /**
   * Validate X-Mock-Scenario header value
   * @param {string} scenarioHeader - The scenario header value
   * @param {string} correlationId - Request correlation ID for tracking
   * @returns {Object} Validation result with details
   */
  validateScenarioHeader(scenarioHeader, correlationId = null) {
    if (!scenarioHeader) {
      return {
        valid: true,
        message: 'No scenario header provided - using default behavior'
      };
    }

    const result = {
      correlationId,
      timestamp: new Date().toISOString(),
      originalHeader: scenarioHeader,
      valid: true,
      scenarios: [],
      errors: [],
      warnings: [],
      suggestions: []
    };

    // Split by comma to handle multiple scenarios
    const scenarios = scenarioHeader.split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    if (scenarios.length === 0) {
      result.valid = false;
      result.errors.push('Empty scenario header after parsing');
      return this.finalizeValidation(result);
    }

    // Validate each scenario
    scenarios.forEach((scenario, index) => {
      const scenarioResult = this.validateSingleScenario(scenario, index);
      result.scenarios.push(scenarioResult);
      
      if (!scenarioResult.valid) {
        result.valid = false;
        result.errors.push(`Scenario ${index + 1} (${scenario}): ${scenarioResult.error}`);
      }

      if (scenarioResult.warning) {
        result.warnings.push(`Scenario ${index + 1} (${scenario}): ${scenarioResult.warning}`);
      }
    });

    // Add general suggestions if there are errors
    if (!result.valid) {
      result.suggestions = this.generateSuggestions(scenarios, result.errors);
    }

    return this.finalizeValidation(result);
  }

  /**
   * Validate a single scenario pattern
   * @param {string} scenario - Single scenario string
   * @param {number} index - Position in scenario list
   * @returns {Object} Single scenario validation result
   */
  validateSingleScenario(scenario, index) {
    const result = {
      index,
      scenario,
      valid: false,
      category: null,
      subcategory: null,
      parameters: {},
      error: null,
      warning: null
    };

    // Performance & Network patterns
    if (scenario.startsWith('slow-response-')) {
      return this.validateSlowResponse(scenario, result);
    }
    
    if (scenario.startsWith('request-timeout-after-')) {
      return this.validateRequestTimeout(scenario, result);
    }
    
    // Network error patterns (exact matches)
    const networkPatterns = ['connection-reset', 'connection-refused', 'network-unreachable', 'dns-resolution-failure'];
    if (networkPatterns.includes(scenario)) {
      result.valid = true;
      result.category = 'network';
      result.subcategory = scenario;
      return result;
    }

    // HTTP Error patterns
    const httpErrorResult = this.validateHttpError(scenario, result);
    if (httpErrorResult) return httpErrorResult;

    // Authentication patterns
    const authResult = this.validateAuthScenario(scenario, result);
    if (authResult) return authResult;

    // Data patterns
    const dataResult = this.validateDataScenario(scenario, result);
    if (dataResult) return dataResult;

    // If we reach here, the scenario is invalid
    result.error = `Unknown scenario pattern '${scenario}'`;
    result.valid = false;
    return result;
  }

  /**
   * Validate slow-response-[ms] pattern
   */
  validateSlowResponse(scenario, result) {
    const match = scenario.match(this.SCENARIO_PATTERNS.slowResponse);
    if (!match) {
      result.error = 'Invalid slow-response pattern. Expected: slow-response-[milliseconds]';
      return result;
    }

    const ms = parseInt(match[1]);
    result.parameters.delay = ms;
    result.category = 'performance';
    result.subcategory = 'slow-response';

    if (ms < 0) {
      result.error = 'Delay cannot be negative';
      return result;
    }

    if (ms > 60000) {
      result.error = 'Delay cannot exceed 60000ms (60 seconds)';
      return result;
    }

    if (ms > 10000) {
      result.warning = 'Delay over 10 seconds may cause client timeouts';
    }

    result.valid = true;
    return result;
  }

  /**
   * Validate request-timeout-after-[ms] pattern
   */
  validateRequestTimeout(scenario, result) {
    const match = scenario.match(this.SCENARIO_PATTERNS.requestTimeout);
    if (!match) {
      result.error = 'Invalid request-timeout pattern. Expected: request-timeout-after-[milliseconds]';
      return result;
    }

    const ms = parseInt(match[1]);
    result.parameters.timeout = ms;
    result.category = 'performance';
    result.subcategory = 'request-timeout';

    if (ms < 0) {
      result.error = 'Timeout cannot be negative';
      return result;
    }

    if (ms > 60000) {
      result.error = 'Timeout cannot exceed 60000ms (60 seconds)';
      return result;
    }

    result.valid = true;
    return result;
  }

  /**
   * Validate HTTP error patterns
   */
  validateHttpError(scenario, result) {
    const errorPatterns = [
      { pattern: this.SCENARIO_PATTERNS.error400, code: 400, name: 'bad-request' },
      { pattern: this.SCENARIO_PATTERNS.error401, code: 401, name: 'unauthorized' },
      { pattern: this.SCENARIO_PATTERNS.error403, code: 403, name: 'forbidden' },
      { pattern: this.SCENARIO_PATTERNS.error404, code: 404, name: 'not-found' },
      { pattern: this.SCENARIO_PATTERNS.error405, code: 405, name: 'method-not-allowed' },
      { pattern: this.SCENARIO_PATTERNS.error409, code: 409, name: 'conflict' },
      { pattern: this.SCENARIO_PATTERNS.error422, code: 422, name: 'validation-failed' },
      { pattern: this.SCENARIO_PATTERNS.error429, code: 429, name: 'too-many-requests' },
      { pattern: this.SCENARIO_PATTERNS.error500, code: 500, name: 'internal' },
      { pattern: this.SCENARIO_PATTERNS.error502, code: 502, name: 'bad-gateway' },
      { pattern: this.SCENARIO_PATTERNS.error503, code: 503, name: 'service-unavailable' },
      { pattern: this.SCENARIO_PATTERNS.error504, code: 504, name: 'gateway-timeout' },
      { pattern: this.SCENARIO_PATTERNS.error507, code: 507, name: 'insufficient-storage' }
    ];

    for (const { pattern, code, name } of errorPatterns) {
      if (pattern.test(scenario)) {
        result.valid = true;
        result.category = 'error';
        result.subcategory = 'http-error';
        result.parameters.statusCode = code;
        result.parameters.errorName = name;
        return result;
      }
    }

    return null;
  }

  /**
   * Validate authentication scenarios
   */
  validateAuthScenario(scenario, result) {
    // Valid auth patterns
    const validAuthPatterns = [
      { pattern: this.SCENARIO_PATTERNS.validAuthBearer, method: 'bearer' },
      { pattern: this.SCENARIO_PATTERNS.validAuthBasic, method: 'basic' },
      { pattern: this.SCENARIO_PATTERNS.validAuthJwt, method: 'jwt' },
      { pattern: this.SCENARIO_PATTERNS.validAuthOauth2, method: 'oauth2' }
    ];

    for (const { pattern, method } of validAuthPatterns) {
      if (pattern.test(scenario)) {
        result.valid = true;
        result.category = 'auth';
        result.subcategory = 'valid';
        result.parameters.method = method;
        return result;
      }
    }

    // API Key with header name
    const apiKeyMatch = scenario.match(this.SCENARIO_PATTERNS.validAuthApiKey);
    if (apiKeyMatch) {
      result.valid = true;
      result.category = 'auth';
      result.subcategory = 'valid';
      result.parameters.method = 'apikey';
      result.parameters.header = apiKeyMatch[1];
      return result;
    }

    // Invalid auth patterns
    const invalidAuthPatterns = [
      { pattern: this.SCENARIO_PATTERNS.invalidAuthBearer, method: 'bearer' },
      { pattern: this.SCENARIO_PATTERNS.invalidAuthBearerExpired, method: 'bearer', reason: 'expired' },
      { pattern: this.SCENARIO_PATTERNS.invalidAuthBearerMalformed, method: 'bearer', reason: 'malformed' },
      { pattern: this.SCENARIO_PATTERNS.invalidAuthBasic, method: 'basic' },
      { pattern: this.SCENARIO_PATTERNS.invalidAuthBasicFormat, method: 'basic', reason: 'format' },
      { pattern: this.SCENARIO_PATTERNS.invalidAuthJwt, method: 'jwt' },
      { pattern: this.SCENARIO_PATTERNS.invalidAuthJwtExpired, method: 'jwt', reason: 'expired' },
      { pattern: this.SCENARIO_PATTERNS.invalidAuthOauth2, method: 'oauth2' }
    ];

    for (const { pattern, method, reason } of invalidAuthPatterns) {
      if (pattern.test(scenario)) {
        result.valid = true;
        result.category = 'auth';
        result.subcategory = 'invalid';
        result.parameters.method = method;
        if (reason) result.parameters.reason = reason;
        return result;
      }
    }

    // Missing auth patterns
    const missingAuthPatterns = [
      { pattern: this.SCENARIO_PATTERNS.missingAuthBearer, method: 'bearer' },
      { pattern: this.SCENARIO_PATTERNS.missingAuthBasic, method: 'basic' },
      { pattern: this.SCENARIO_PATTERNS.missingAuthJwt, method: 'jwt' },
      { pattern: this.SCENARIO_PATTERNS.missingAuthOauth2, method: 'oauth2' }
    ];

    for (const { pattern, method } of missingAuthPatterns) {
      if (pattern.test(scenario)) {
        result.valid = true;
        result.category = 'auth';
        result.subcategory = 'missing';
        result.parameters.method = method;
        return result;
      }
    }

    return null;
  }

  /**
   * Validate data scenarios
   */
  validateDataScenario(scenario, result) {
    // Partial data
    if (scenario.startsWith('partial-data-')) {
      const match = scenario.match(this.SCENARIO_PATTERNS.partialData);
      if (match) {
        const percent = parseInt(match[1]);
        if (percent < 0 || percent > 100) {
          result.error = 'Percentage must be between 0 and 100';
          return result;
        }
        result.valid = true;
        result.category = 'data';
        result.subcategory = 'partial';
        result.parameters.percent = percent;
        return result;
      }
      result.error = 'Invalid partial-data pattern. Expected: partial-data-[0-100]';
      return result;
    }

    // Field manipulation patterns
    const fieldPatterns = [
      { prefix: 'data-missing-field-', pattern: this.SCENARIO_PATTERNS.dataMissingField, type: 'missing-field' },
      { prefix: 'data-null-field-', pattern: this.SCENARIO_PATTERNS.dataNullField, type: 'null-field' },
      { prefix: 'data-wrong-type-field-', pattern: this.SCENARIO_PATTERNS.dataWrongTypeField, type: 'wrong-type-field' }
    ];

    for (const { prefix, pattern, type } of fieldPatterns) {
      if (scenario.startsWith(prefix)) {
        const match = scenario.match(pattern);
        if (match) {
          result.valid = true;
          result.category = 'data';
          result.subcategory = type;
          result.parameters.field = match[1];
          return result;
        }
        result.error = `Invalid ${type} pattern. Expected: ${prefix}[fieldName]`;
        return result;
      }
    }

    // Simple data patterns
    if (this.SCENARIO_PATTERNS.dataCorrupted.test(scenario)) {
      result.valid = true;
      result.category = 'data';
      result.subcategory = 'corrupted';
      return result;
    }

    if (this.SCENARIO_PATTERNS.dataExtraFields.test(scenario)) {
      result.valid = true;
      result.category = 'data';
      result.subcategory = 'extra-fields';
      return result;
    }

    // Data truncated
    if (scenario.startsWith('data-truncated-')) {
      const match = scenario.match(this.SCENARIO_PATTERNS.dataTruncated);
      if (match) {
        const percent = parseInt(match[1]);
        if (percent < 0 || percent > 100) {
          result.error = 'Truncation percentage must be between 0 and 100';
          return result;
        }
        result.valid = true;
        result.category = 'data';
        result.subcategory = 'truncated';
        result.parameters.percent = percent;
        return result;
      }
      result.error = 'Invalid data-truncated pattern. Expected: data-truncated-[0-100]';
      return result;
    }

    return null;
  }

  /**
   * Generate helpful suggestions based on validation errors
   */
  generateSuggestions(scenarios, errors) {
    const suggestions = [];
    
    // Analyze common error patterns
    const hasSlowResponseError = errors.some(e => e.includes('slow-response'));
    const hasTimeoutError = errors.some(e => e.includes('timeout'));
    const hasAuthError = errors.some(e => e.includes('auth'));
    const hasDataError = errors.some(e => e.includes('data-'));
    const hasErrorCodeError = errors.some(e => e.includes('error-'));

    if (hasSlowResponseError) {
      suggestions.push('Use format: slow-response-[milliseconds], e.g., slow-response-2000 for 2 second delay');
    }

    if (hasTimeoutError) {
      suggestions.push('Use format: request-timeout-after-[milliseconds], e.g., request-timeout-after-5000');
    }

    if (hasAuthError) {
      suggestions.push('Auth scenarios: valid-auth-bearer, invalid-auth-jwt, missing-auth-basic, valid-auth-apikey-X-API-Key');
    }

    if (hasDataError) {
      suggestions.push('Data scenarios: partial-data-50, data-missing-field-id, data-null-field-name, data-corrupted-json');
    }

    if (hasErrorCodeError) {
      suggestions.push('Error scenarios: error-404-not-found, error-500-internal, error-401-unauthorized');
    }

    // Add general suggestions
    suggestions.push('Multiple scenarios can be combined with commas: slow-response-1000,error-500-internal');
    suggestions.push('Use /scenarios endpoint to see all available patterns');

    return suggestions;
  }


  /**
   * Finalize validation and log result
   */
  finalizeValidation(result) {

    // Log validation result
    if (!result.valid) {
      this.logger.warn({
        correlationId: result.correlationId,
        header: result.originalHeader,
        errors: result.errors,
        suggestions: result.suggestions
      }, `❌ Invalid scenario header: ${result.originalHeader}`);
    } else if (result.warnings.length > 0) {
      this.logger.warn({
        correlationId: result.correlationId,
        header: result.originalHeader,
        warnings: result.warnings
      }, `⚠️ Scenario header has warnings: ${result.originalHeader}`);
    } else {
      this.logger.debug({
        correlationId: result.correlationId,
        header: result.originalHeader,
        scenarios: result.scenarios.length
      }, `✅ Valid scenario header: ${result.originalHeader}`);
    }

    return result;
  }

}

module.exports = ScenarioValidator;