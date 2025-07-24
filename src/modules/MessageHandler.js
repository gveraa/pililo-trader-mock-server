const jp = require('jsonpath');
const { EventEmitter } = require('events');

class MessageHandler extends EventEmitter {
  constructor(logger, templateEngine) {
    super();
    this.logger = logger;
    this.templateEngine = templateEngine;
    this.messageHistory = new Map(); // Store recent messages per connection
    this.ruleExecutionCount = new Map(); // Track rule executions
  }

  /**
   * Handle incoming WebSocket message
   * @param {string} connectionId - Connection identifier
   * @param {Buffer|string} rawMessage - Raw message from WebSocket
   * @param {Object} config - Configuration for this connection
   * @param {Object} connectionInfo - Connection information
   * @returns {Array} Array of matched rules
   */
  async handleIncomingMessage(connectionId, rawMessage, config, connectionInfo) {
    const startTime = Date.now();
    
    try {
      // Parse message
      const { parsed, type } = this.parseMessage(rawMessage);
      
      // Store in history
      this.addToHistory(connectionId, {
        direction: 'incoming',
        message: parsed,
        type,
        timestamp: new Date()
      });

      this.logger.debug({
        connectionId,
        messageType: type,
        configName: config.name
      }, 'Processing incoming message');

      // Process response rules
      const matchedRules = [];
      
      if (config.responseRules && config.responseRules.length > 0) {
        for (const rule of config.responseRules) {
          if (!rule.enabled) continue;

          const matchResult = await this.evaluateRule(parsed, rule, connectionId);
          
          if (matchResult.matches) {
            matchedRules.push({
              rule,
              matchResult,
              executionTime: Date.now() - startTime
            });

            this.emit('rule:matched', {
              connectionId,
              ruleId: rule.id,
              message: parsed,
              matchResult
            });

            // Track rule execution
            this.incrementRuleExecution(config.name, rule.id);

            // Schedule response if needed
            if (rule.response) {
              this.scheduleResponse(connectionId, rule, parsed, connectionInfo);
            }

            // Stop processing if rule doesn't allow multiple matches
            if (!rule.response?.multiple) {
              break;
            }
          }
        }
      }

      const processingTime = Date.now() - startTime;
      
      this.logger.debug({
        connectionId,
        matchedRules: matchedRules.length,
        processingTime
      }, 'Message processing completed');

      this.emit('message:processed', {
        connectionId,
        message: parsed,
        matchedRules,
        processingTime
      });

      return matchedRules;
    } catch (error) {
      this.logger.error({
        connectionId,
        error: error.message
      }, 'Error handling incoming message');
      
      this.emit('message:error', {
        connectionId,
        error,
        rawMessage
      });
      
      return [];
    }
  }

  /**
   * Parse incoming message
   * @param {Buffer|string} rawMessage - Raw message
   * @returns {Object} Parsed message and type
   */
  parseMessage(rawMessage) {
    let parsed;
    let type;

    try {
      const messageStr = rawMessage.toString();
      parsed = JSON.parse(messageStr);
      type = 'json';
    } catch {
      // Not JSON, treat as string
      parsed = rawMessage.toString();
      type = 'string';
    }

    return { parsed, type };
  }

  /**
   * Evaluate if a message matches a rule
   * @param {any} message - Message to evaluate
   * @param {Object} rule - Rule to match against
   * @param {string} connectionId - Connection ID for context
   * @returns {Object} Match result
   */
  async evaluateRule(message, rule, connectionId) {
    const startTime = Date.now();
    
    try {
      const matcher = rule.matcher;
      let matches = false;
      let extractedData = {};

      switch (matcher.type) {
        case 'exact':
          matches = this.matchExact(message, matcher.value);
          break;

        case 'contains':
          matches = this.matchContains(message, matcher.value);
          break;

        case 'regex':
          const regexResult = this.matchRegex(message, matcher.value);
          matches = regexResult.matches;
          extractedData = regexResult.groups || {};
          break;

        case 'jsonPath':
          const jsonPathResult = this.matchJsonPath(message, matcher.path, matcher.value);
          matches = jsonPathResult.matches;
          extractedData = jsonPathResult.extracted || {};
          break;

        case 'custom':
          // Placeholder for custom matcher support
          if (matcher.function) {
            matches = await this.evaluateCustomMatcher(message, matcher.function, connectionId);
          }
          break;

        default:
          this.logger.warn({
            matcherType: matcher.type,
            ruleId: rule.id
          }, 'Unknown matcher type');
      }

      return {
        matches,
        matcherType: matcher.type,
        extractedData,
        evaluationTime: Date.now() - startTime
      };
    } catch (error) {
      this.logger.error({
        ruleId: rule.id,
        error: error.message
      }, 'Error evaluating rule');
      
      return {
        matches: false,
        error: error.message,
        evaluationTime: Date.now() - startTime
      };
    }
  }

  /**
   * Exact match comparison
   * @param {any} message - Message to match
   * @param {any} value - Value to match against
   * @returns {boolean} Match result
   */
  matchExact(message, value) {
    if (typeof message === 'object' && typeof value === 'object') {
      return JSON.stringify(message) === JSON.stringify(value);
    }
    return message === value;
  }

  /**
   * Contains match comparison
   * @param {any} message - Message to match
   * @param {any} value - Value to search for
   * @returns {boolean} Match result
   */
  matchContains(message, value) {
    if (typeof message === 'string' && typeof value === 'string') {
      return message.includes(value);
    }
    
    if (typeof message === 'object' && typeof value === 'object') {
      // Check if value object is contained in message object
      return this.objectContains(message, value);
    }
    
    // Convert to string for comparison
    const messageStr = typeof message === 'string' ? message : JSON.stringify(message);
    const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
    return messageStr.includes(valueStr);
  }

  /**
   * Check if an object contains another object's properties
   * @param {Object} obj - Object to search in
   * @param {Object} subset - Object to search for
   * @returns {boolean} Contains result
   */
  objectContains(obj, subset) {
    for (const key in subset) {
      if (!(key in obj)) return false;
      
      if (typeof subset[key] === 'object' && subset[key] !== null) {
        if (typeof obj[key] !== 'object' || !this.objectContains(obj[key], subset[key])) {
          return false;
        }
      } else if (obj[key] !== subset[key]) {
        return false;
      }
    }
    return true;
  }

  /**
   * Regex match comparison
   * @param {any} message - Message to match
   * @param {string} pattern - Regex pattern
   * @returns {Object} Match result with groups
   */
  matchRegex(message, pattern) {
    try {
      const regex = new RegExp(pattern);
      const testStr = typeof message === 'string' ? message : JSON.stringify(message);
      const match = testStr.match(regex);
      
      return {
        matches: !!match,
        groups: match ? match.groups || {} : {}
      };
    } catch (error) {
      this.logger.warn({
        pattern,
        error: error.message
      }, 'Invalid regex pattern');
      return { matches: false, groups: {} };
    }
  }

  /**
   * JSONPath match comparison
   * @param {any} message - Message to match
   * @param {string} path - JSONPath expression
   * @param {any} expectedValue - Expected value at path
   * @returns {Object} Match result with extracted data
   */
  matchJsonPath(message, path, expectedValue) {
    if (typeof message !== 'object' || message === null) {
      return { matches: false, extracted: {} };
    }

    try {
      const results = jp.query(message, path);
      
      if (results.length === 0) {
        return { matches: false, extracted: {} };
      }

      // If no expected value, just check if path exists
      if (expectedValue === undefined) {
        return {
          matches: true,
          extracted: { [path]: results[0] }
        };
      }

      // Check if any result matches expected value
      const matches = results.some(result => 
        JSON.stringify(result) === JSON.stringify(expectedValue)
      );

      return {
        matches,
        extracted: matches ? { [path]: results[0] } : {}
      };
    } catch (error) {
      this.logger.warn({
        path,
        error: error.message
      }, 'JSONPath evaluation error');
      return { matches: false, extracted: {} };
    }
  }

  /**
   * Schedule a response to be sent
   * @param {string} connectionId - Connection ID
   * @param {Object} rule - Rule that matched
   * @param {any} originalMessage - Original incoming message
   * @param {Object} connectionInfo - Connection information
   */
  scheduleResponse(connectionId, rule, originalMessage, connectionInfo) {
    const delay = rule.response.delay || 0;
    
    setTimeout(() => {
      try {
        // Process template with context
        const context = {
          request: originalMessage,
          connection: connectionInfo,
          rule: {
            id: rule.id,
            matchedAt: new Date().toISOString()
          }
        };

        const responseMessage = this.templateEngine.process(
          rule.response.message,
          context
        );

        // Store in history
        this.addToHistory(connectionId, {
          direction: 'outgoing',
          message: responseMessage,
          type: 'response',
          ruleId: rule.id,
          timestamp: new Date()
        });

        this.emit('response:ready', {
          connectionId,
          message: responseMessage,
          ruleId: rule.id
        });

        this.logger.debug({
          connectionId,
          ruleId: rule.id,
          delay
        }, 'Response scheduled');
      } catch (error) {
        this.logger.error({
          connectionId,
          ruleId: rule.id,
          error: error.message
        }, 'Error preparing response');
      }
    }, delay);
  }

  /**
   * Add message to history
   * @param {string} connectionId - Connection ID
   * @param {Object} entry - History entry
   */
  addToHistory(connectionId, entry) {
    if (!this.messageHistory.has(connectionId)) {
      this.messageHistory.set(connectionId, []);
    }

    const history = this.messageHistory.get(connectionId);
    history.push(entry);

    // Keep only last 100 messages per connection
    if (history.length > 100) {
      history.shift();
    }
  }

  /**
   * Get message history for a connection
   * @param {string} connectionId - Connection ID
   * @param {number} limit - Number of messages to return
   * @returns {Array} Message history
   */
  getHistory(connectionId, limit = 50) {
    const history = this.messageHistory.get(connectionId) || [];
    return history.slice(-limit);
  }

  /**
   * Clear history for a connection
   * @param {string} connectionId - Connection ID
   */
  clearHistory(connectionId) {
    this.messageHistory.delete(connectionId);
    
    // Also clear rule execution counts for this connection
    // This is a simplified approach - in production you might want to keep these
    this.logger.debug({ connectionId }, 'Cleared message history');
  }

  /**
   * Increment rule execution counter
   * @param {string} configName - Configuration name
   * @param {string} ruleId - Rule ID
   */
  incrementRuleExecution(configName, ruleId) {
    const key = `${configName}:${ruleId}`;
    const current = this.ruleExecutionCount.get(key) || 0;
    this.ruleExecutionCount.set(key, current + 1);
  }

  /**
   * Get rule execution statistics
   * @param {string} configName - Optional config name filter
   * @returns {Object} Execution statistics
   */
  getRuleStats(configName = null) {
    const stats = {};
    
    for (const [key, count] of this.ruleExecutionCount) {
      const [config, ruleId] = key.split(':');
      
      if (configName && config !== configName) continue;
      
      if (!stats[config]) {
        stats[config] = {};
      }
      
      stats[config][ruleId] = count;
    }
    
    return stats;
  }

  /**
   * Evaluate custom matcher function
   * @param {any} message - Message to evaluate
   * @param {string} functionName - Custom function name
   * @param {string} connectionId - Connection ID
   * @returns {boolean} Match result
   */
  async evaluateCustomMatcher(message, functionName, connectionId) {
    // This is a placeholder for custom matcher support
    // In a real implementation, you might load custom functions from a registry
    this.logger.warn({
      functionName,
      connectionId
    }, 'Custom matcher not implemented');
    
    return false;
  }
}

module.exports = MessageHandler;