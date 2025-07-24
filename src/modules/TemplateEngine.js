class TemplateEngine {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Process template strings with variable replacements
   * @param {any} template - The template object/string to process
   * @param {Object} context - Context object containing request data and other variables
   * @returns {any} Processed template with variables replaced
   */
  process(template, context = {}) {
    try {
      let processed = JSON.stringify(template);

      // Replace {{timestamp}} with current ISO timestamp
      processed = processed.replace(/\{\{timestamp\}\}/g, new Date().toISOString());

      // Replace {{request.fieldName}} with values from request
      processed = processed.replace(/\{\{request\.(\w+)\}\}/g, (match, fieldName) => {
        if (context.request && typeof context.request === 'object' && context.request[fieldName] !== undefined) {
          return JSON.stringify(context.request[fieldName]).slice(1, -1); // Remove quotes
        }
        return match; // Keep original if not found
      });

      // Replace {{connection.fieldName}} with values from connection metadata
      processed = processed.replace(/\{\{connection\.(\w+)\}\}/g, (match, fieldName) => {
        if (context.connection && typeof context.connection === 'object' && context.connection[fieldName] !== undefined) {
          return JSON.stringify(context.connection[fieldName]).slice(1, -1);
        }
        return match;
      });

      // Replace {{random.uuid}} with a random UUID
      processed = processed.replace(/\{\{random\.uuid\}\}/g, () => {
        return this.generateUUID();
      });

      // Replace {{random.number(min,max)}} with a random number
      processed = processed.replace(/\{\{random\.number\((\d+),(\d+)\)\}\}/g, (match, min, max) => {
        return Math.floor(Math.random() * (parseInt(max) - parseInt(min) + 1)) + parseInt(min);
      });

      // Replace {{date.now}} with current timestamp in milliseconds
      processed = processed.replace(/\{\{date\.now\}\}/g, Date.now());

      // Replace {{date.format(pattern)}} with formatted date
      processed = processed.replace(/\{\{date\.format\(([^)]+)\)\}\}/g, (match, pattern) => {
        return this.formatDate(new Date(), pattern.replace(/['"]/g, ''));
      });

      return JSON.parse(processed);
    } catch (error) {
      this.logger.error({ error: error.message, template }, 'Failed to process template');
      return template; // Return original if processing fails
    }
  }

  /**
   * Generate a simple UUID v4
   * @returns {string} UUID
   */
  generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * Simple date formatter
   * @param {Date} date - Date to format
   * @param {string} pattern - Format pattern (supports: YYYY, MM, DD, HH, mm, ss)
   * @returns {string} Formatted date
   */
  formatDate(date, pattern) {
    const replacements = {
      'YYYY': date.getFullYear(),
      'MM': String(date.getMonth() + 1).padStart(2, '0'),
      'DD': String(date.getDate()).padStart(2, '0'),
      'HH': String(date.getHours()).padStart(2, '0'),
      'mm': String(date.getMinutes()).padStart(2, '0'),
      'ss': String(date.getSeconds()).padStart(2, '0')
    };

    let formatted = pattern;
    Object.entries(replacements).forEach(([key, value]) => {
      formatted = formatted.replace(new RegExp(key, 'g'), value);
    });

    return formatted;
  }

  /**
   * Validate template syntax
   * @param {any} template - Template to validate
   * @returns {Object} Validation result with isValid and errors
   */
  validate(template) {
    const errors = [];
    const templateStr = JSON.stringify(template);
    
    // Check for unclosed template variables
    const unclosed = templateStr.match(/\{\{[^}]*$/g);
    if (unclosed) {
      errors.push(`Unclosed template variable found: ${unclosed[0]}`);
    }

    // Check for invalid template variable syntax
    const invalidVars = templateStr.match(/\{\{[^}]*[^a-zA-Z0-9._(),'"\s][^}]*\}\}/g);
    if (invalidVars) {
      errors.push(`Invalid template variable syntax: ${invalidVars.join(', ')}`);
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }
}

module.exports = TemplateEngine;