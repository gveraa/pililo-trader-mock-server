/**
 * High-performance template engine that avoids JSON.stringify/parse overhead
 * 
 * Key optimizations:
 * - Direct object traversal instead of string manipulation
 * - Cached regex patterns
 * - Native crypto.randomUUID when available
 * - Pre-computed date components
 */

const crypto = require('crypto');

// Pre-compiled regex patterns
const TEMPLATE_PATTERNS = {
  timestamp: /\{\{timestamp\}\}/,
  request: /\{\{request\.(\w+)\}\}/,
  connection: /\{\{connection\.(\w+)\}\}/,
  randomUuid: /\{\{random\.uuid\}\}/,
  randomNumber: /\{\{random\.number\((\d+),(\d+)\)\}\}/,
  dateNow: /\{\{date\.now\}\}/,
  dateFormat: /\{\{date\.format\(([^)]+)\)\}\}/
};

// Check if string contains any template
const QUICK_CHECK = /\{\{[^}]+\}\}/;

class FastTemplateEngine {
  constructor(logger) {
    this.logger = logger;
    
    // Use native UUID if available (Node 14.17+)
    this.generateUUID = crypto.randomUUID || this.fallbackUUID.bind(this);
    
    // Cache for date formatting
    this.dateCache = new Map();
    this.dateCacheSize = 0;
  }

  /**
   * Process template with minimal overhead
   */
  process(template, context = {}) {
    try {
      // Fast path: if not an object or string, return as-is
      if (template === null || template === undefined) {
        return template;
      }

      const type = typeof template;
      
      if (type === 'string') {
        return this.processString(template, context);
      } else if (type === 'object') {
        return Array.isArray(template) 
          ? this.processArray(template, context)
          : this.processObject(template, context);
      }
      
      // Primitives pass through
      return template;
    } catch (error) {
      this.logger.error({ error: error.message }, 'Template processing failed');
      return template;
    }
  }

  /**
   * Process string templates
   */
  processString(str, context) {
    // Quick check if string contains templates
    if (!QUICK_CHECK.test(str)) {
      return str;
    }

    let result = str;

    // Process templates in order of frequency
    if (TEMPLATE_PATTERNS.timestamp.test(result)) {
      result = result.replace(TEMPLATE_PATTERNS.timestamp, new Date().toISOString());
    }

    if (context.request && TEMPLATE_PATTERNS.request.test(result)) {
      result = result.replace(TEMPLATE_PATTERNS.request, (match, field) => {
        const value = context.request[field];
        return value !== undefined ? String(value) : match;
      });
    }

    if (context.connection && TEMPLATE_PATTERNS.connection.test(result)) {
      result = result.replace(TEMPLATE_PATTERNS.connection, (match, field) => {
        const value = context.connection[field];
        return value !== undefined ? String(value) : match;
      });
    }

    if (TEMPLATE_PATTERNS.dateNow.test(result)) {
      result = result.replace(TEMPLATE_PATTERNS.dateNow, Date.now());
    }

    if (TEMPLATE_PATTERNS.randomUuid.test(result)) {
      result = result.replace(TEMPLATE_PATTERNS.randomUuid, this.generateUUID());
    }

    if (TEMPLATE_PATTERNS.randomNumber.test(result)) {
      result = result.replace(TEMPLATE_PATTERNS.randomNumber, (match, min, max) => {
        const minNum = parseInt(min);
        const maxNum = parseInt(max);
        return Math.floor(Math.random() * (maxNum - minNum + 1)) + minNum;
      });
    }

    if (TEMPLATE_PATTERNS.dateFormat.test(result)) {
      result = result.replace(TEMPLATE_PATTERNS.dateFormat, (match, pattern) => {
        return this.formatDate(new Date(), pattern.replace(/['"]/g, ''));
      });
    }

    return result;
  }

  /**
   * Process object without JSON.stringify
   */
  processObject(obj, context) {
    const processed = {};
    
    for (const [key, value] of Object.entries(obj)) {
      processed[key] = this.process(value, context);
    }
    
    return processed;
  }

  /**
   * Process array without JSON.stringify
   */
  processArray(arr, context) {
    const processed = new Array(arr.length);
    
    for (let i = 0; i < arr.length; i++) {
      processed[i] = this.process(arr[i], context);
    }
    
    return processed;
  }

  /**
   * Fallback UUID for older Node versions
   */
  fallbackUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * Fast date formatter with caching
   */
  formatDate(date, pattern) {
    // Cache key includes pattern and date rounded to minute
    const minute = Math.floor(date.getTime() / 60000);
    const cacheKey = `${pattern}-${minute}`;
    
    // Check cache
    const cached = this.dateCache.get(cacheKey);
    if (cached) {
      // Update seconds for cached result
      return cached.replace('ss', String(date.getSeconds()).padStart(2, '0'));
    }

    // Format date
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    
    let formatted = pattern
      .replace(/YYYY/g, year)
      .replace(/MM/g, month)
      .replace(/DD/g, day)
      .replace(/HH/g, hours)
      .replace(/mm/g, minutes);
    
    // Cache result (without seconds)
    if (this.dateCacheSize < 100) {
      this.dateCache.set(cacheKey, formatted);
      this.dateCacheSize++;
    } else {
      // Clear cache when it gets too big
      this.dateCache.clear();
      this.dateCacheSize = 0;
    }
    
    // Add seconds
    return formatted.replace(/ss/g, String(date.getSeconds()).padStart(2, '0'));
  }

  /**
   * Validate template syntax (keep for compatibility)
   */
  validate(template) {
    try {
      const str = JSON.stringify(template);
      const errors = [];
      
      // Check for unclosed template variables
      const unclosed = str.match(/\{\{[^}]*$/g);
      if (unclosed) {
        errors.push(`Unclosed template variable found: ${unclosed[0]}`);
      }

      // Check for invalid template variable syntax
      const invalidVars = str.match(/\{\{[^}]*[^a-zA-Z0-9._(),'"\s][^}]*\}\}/g);
      if (invalidVars) {
        errors.push(`Invalid template variable syntax: ${invalidVars.join(', ')}`);
      }

      return {
        isValid: errors.length === 0,
        errors
      };
    } catch (error) {
      return {
        isValid: false,
        errors: [error.message]
      };
    }
  }
}

module.exports = FastTemplateEngine;