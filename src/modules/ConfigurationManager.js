const fs = require('fs').promises;
const path = require('path');
const glob = require('glob');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

class ConfigurationManager {
  constructor(logger) {
    this.logger = logger;
    this.ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(this.ajv);
    this.configs = new Map();
    this.validate = null;
  }

  /**
   * Load JSON schema for configuration validation
   * @param {string} schemaPath - Path to the schema file
   */
  async loadSchema(schemaPath = null) {
    try {
      // Load base schema and referenced schemas
      const baseSchemaPath = schemaPath || path.join(__dirname, '../../schema/mock-base-schema.json');
      const wsSchemaPath = path.join(__dirname, '../../schema/websocket-mock-schema.json');
      const apiSchemaPath = path.join(__dirname, '../../schema/api-mock-schema.json');
      
      // Load all schemas
      const baseSchemaContent = await fs.readFile(baseSchemaPath, 'utf8');
      const wsSchemaContent = await fs.readFile(wsSchemaPath, 'utf8');
      const apiSchemaContent = await fs.readFile(apiSchemaPath, 'utf8');
      
      this.baseSchema = JSON.parse(baseSchemaContent);
      this.wsSchema = JSON.parse(wsSchemaContent);
      this.apiSchema = JSON.parse(apiSchemaContent);
      
      // Add schemas to AJV
      this.ajv.addSchema(this.wsSchema, 'websocket-mock-schema.json');
      this.ajv.addSchema(this.apiSchema, 'api-mock-schema.json');
      
      // Compile base schema
      this.validate = this.ajv.compile(this.baseSchema);
      // Schemas loaded successfully
    } catch (error) {
      this.logger.error({ error: error.message }, 'Failed to load schemas');
      throw error;
    }
  }

  /**
   * Load all mock configurations from directory (both root files and subdirectories)
   * @param {string} configDir - Directory containing configuration files and subdirectories
   * @param {Object} options - Loading options
   * @returns {Object} Loading results with merged configuration
   */
  async loadConfigurations(configDir = 'mocks', options = {}) {
    const { 
      stopOnError = false,
      validateOnly = false 
    } = options;

    const results = {
      configurations: [],
      summary: {
        total: 0,
        loaded: 0,
        failed: 0,
        errors: []
      }
    };

    try {
      const configPath = path.join(process.cwd(), configDir);
      
      // Check if directory exists
      try {
        await fs.access(configPath);
      } catch (error) {
        this.logger.error({ configDir: configPath }, 'Configuration directory does not exist');
        throw new Error(`Configuration directory does not exist: ${configPath}`);
      }

      const files = glob.sync('**/*.json', { cwd: configPath });
      results.summary.total = files.length;

      if (files.length === 0) {
        this.logger.warn({ configDir }, 'No JSON files found in configuration directory or subdirectories');
        return results;
      }

      // Load all configuration files

      // Group configurations by type
      const wsConfigs = [];
      const apiConfigs = [];

      // Load and merge all configurations
      for (const file of files) {
        const filePath = path.join(configPath, file);
        
        try {
          const config = await this.loadSingleConfiguration(filePath, file, true, true);
          
          if (config && !config.isError) {
            // Determine prefix based on file location
            const prefix = file.includes('/') ? path.dirname(file) : 'root';
            
            // Group by type
            if (config.type === 'ws') {
              wsConfigs.push({ config, prefix });
            } else if (config.type === 'api') {
              apiConfigs.push({ config, prefix });
            }
            
            results.summary.loaded++;
          } else if (config && config.isError) {
            // Got detailed error information
            this.logger.error({
              file,
              status: 'failed',
              type: config.type,
              errors: config.errors
            }, `✗ Failed: ${file}`);
            results.summary.failed++;
            results.summary.errors.push({
              file,
              type: config.type,
              errors: config.errors
            });
            
            if (stopOnError) {
              break;
            }
          } else {
            // Shouldn't happen with returnErrors=true, but handle it
            results.summary.failed++;
            results.summary.errors.push({
              file,
              type: 'unknown',
              errors: ['Configuration validation failed']
            });
          }
        } catch (error) {
          results.summary.failed++;
          results.summary.errors.push({
            file,
            type: 'unknown',
            errors: [error.message]
          });
          
          if (stopOnError) {
            throw error;
          }
        }
      }

      // Create merged WebSocket configuration if any
      if (wsConfigs.length > 0) {
        const mergedWsConfig = {
          name: 'merged-websocket-server',
          type: 'ws',
          description: 'Merged WebSocket configuration from all sources',
          scheduledMessages: [],
          responseRules: [],
          connectionBehavior: null,
          _mergedConfigs: [],
          _sources: wsConfigs.map(c => c.config._metadata.fileName)
        };
        
        // Merge all WS configs
        for (const { config, prefix } of wsConfigs) {
          this.mergeConfigIntoMaster(mergedWsConfig, config, prefix);
        }
        
        if (!validateOnly) {
          this.configs.set(mergedWsConfig.name, mergedWsConfig);
        }
        results.configurations.push(mergedWsConfig);
        
      }
      
      // Create merged API configuration if any
      if (apiConfigs.length > 0) {
        const mergedApiConfig = {
          name: 'merged-api-server',
          type: 'api',
          description: 'Merged API configuration from all sources',
          mappings: [],
          _mergedConfigs: [],
          _sources: apiConfigs.map(c => c.config._metadata.fileName)
        };
        
        // Merge all API configs
        for (const { config, prefix } of apiConfigs) {
          this.mergeApiConfigIntoMaster(mergedApiConfig, config, prefix);
        }
        
        if (!validateOnly) {
          this.configs.set(mergedApiConfig.name, mergedApiConfig);
        }
        results.configurations.push(mergedApiConfig);
        
      }


      return results;
    } catch (error) {
      this.logger.error({ error: error.message }, 'Failed to load mock configurations');
      throw error;
    }
  }

  /**
   * Load a single configuration file
   * @param {string} filePath - Full path to the configuration file
   * @param {string} fileName - Name of the file for logging
   * @param {boolean} skipPortConflictCheck - Skip port conflict validation
   * @param {boolean} returnErrors - Return error details instead of null
   * @returns {Object|null} Loaded configuration or null if invalid (or error object if returnErrors is true)
   */
  async loadSingleConfiguration(filePath, fileName, skipPortConflictCheck = false, returnErrors = false) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const config = JSON.parse(content);

      // Validate configuration
      const validationResult = this.validateConfiguration(config, skipPortConflictCheck);
      if (!validationResult.isValid) {
        if (returnErrors) {
          return {
            isError: true,
            type: config.type || 'unknown',
            errors: validationResult.errors
          };
        }
        return null;
      }

      // Add metadata
      config._metadata = {
        filePath,
        fileName,
        loadedAt: new Date().toISOString()
      };

      this.logConfiguration(config, fileName);
      return config;
    } catch (error) {
      this.logger.error({
        file: fileName,
        error: error.message
      }, 'Failed to load configuration file');
      
      if (returnErrors) {
        return {
          isError: true,
          type: 'unknown',
          errors: [`Failed to load file: ${error.message}`]
        };
      }
      return null;
    }
  }

  /**
   * Validate a configuration against the schema
   * @param {Object} config - Configuration to validate
   * @param {boolean} skipPortConflictCheck - Skip port conflict validation
   * @returns {Object} Validation result
   */
  validateConfiguration(config, skipPortConflictCheck = false) {
    if (!this.validate) {
      return {
        isValid: false,
        errors: ['Schema not loaded']
      };
    }

    const isValid = this.validate(config);
    const errors = this.validate.errors || [];

    // Additional semantic validation
    const semanticErrors = this.performSemanticValidation(config, skipPortConflictCheck);
    
    return {
      isValid: isValid && semanticErrors.length === 0,
      errors: [...errors.map(e => `${e.instancePath}: ${e.message}`), ...semanticErrors]
    };
  }

  /**
   * Perform semantic validation beyond schema validation
   * @param {Object} config - Configuration to validate
   * @param {boolean} skipPortConflictCheck - Skip port conflict validation
   * @returns {Array} Array of error messages
   */
  performSemanticValidation(config, skipPortConflictCheck = false) {
    const errors = [];

    // Check for duplicate rule IDs
    if (config.responseRules) {
      const ruleIds = config.responseRules.map(r => r.id);
      const duplicates = ruleIds.filter((id, index) => ruleIds.indexOf(id) !== index);
      if (duplicates.length > 0) {
        errors.push(`Duplicate response rule IDs found: ${duplicates.join(', ')}`);
      }
    }

    // Check for duplicate scheduled message IDs
    if (config.scheduledMessages) {
      const messageIds = config.scheduledMessages.map(m => m.id);
      const duplicates = messageIds.filter((id, index) => messageIds.indexOf(id) !== index);
      if (duplicates.length > 0) {
        errors.push(`Duplicate scheduled message IDs found: ${duplicates.join(', ')}`);
      }
    }

    // Port conflict check is no longer needed since we use single port

    // Type-specific validation
    if (config.type === 'ws') {
      // Validate JSONPath expressions for WebSocket
      if (config.responseRules) {
        config.responseRules.forEach(rule => {
          if (rule.matcher.type === 'jsonPath' && rule.matcher.path) {
            try {
              // Basic JSONPath syntax check
              if (!rule.matcher.path.startsWith('$')) {
                errors.push(`Rule ${rule.id}: JSONPath must start with '$'`);
              }
            } catch (e) {
              errors.push(`Rule ${rule.id}: Invalid JSONPath expression`);
            }
          }
        });
      }
    } else if (config.type === 'api') {
      // Check for duplicate mapping IDs
      if (config.mappings) {
        const mappingIds = config.mappings.filter(m => m.id).map(m => m.id);
        const duplicates = mappingIds.filter((id, index) => mappingIds.indexOf(id) !== index);
        if (duplicates.length > 0) {
          errors.push(`Duplicate mapping IDs found: ${duplicates.join(', ')}`);
        }
        
        // Validate each mapping has either urlPath or urlPathPattern
        config.mappings.forEach((mapping, index) => {
          if (!mapping.request.urlPath && !mapping.request.urlPathPattern) {
            errors.push(`Mapping ${mapping.id || index}: Must have either urlPath or urlPathPattern`);
          }
        });
      }
    }

    return errors;
  }

  /**
   * Log configuration details
   * @param {Object} config - Configuration to log
   * @param {string} filename - Configuration filename
   */
  logConfiguration(config, filename) {
    let details = [];
    
    if (config.type === 'ws') {
      // Add WebSocket operations
      if (config.scheduledMessages) {
        config.scheduledMessages.forEach(msg => {
          details.push(`scheduled:${msg.id}@${msg.interval}ms`);
        });
      }
      if (config.responseRules) {
        config.responseRules.forEach(rule => {
          const matcherInfo = rule.matcher.type === 'jsonPath' ? 
            `[${rule.matcher.type}:${rule.matcher.path}]` : 
            `[${rule.matcher.type}]`;
          details.push(`rule:${rule.id}${matcherInfo}`);
        });
      }
    } else if (config.type === 'api') {
      // Add API endpoints
      if (config.mappings) {
        config.mappings.forEach(mapping => {
          const method = mapping.request.method || 'ANY';
          const path = mapping.request.urlPath || mapping.request.urlPathPattern || '/*';
          details.push(`${method} ${path}`);
        });
      }
    }
    
    this.logger.info({
      file: filename,
      status: 'succeed',
      type: config.type,
      operations: details
    }, `✓ Loaded: ${filename}`);
  }

  /**
   * Merge two configurations with the same port
   * @param {Object} existingConfig - The existing configuration to merge into
   * @param {Object} newConfig - The new configuration to merge from
   */
  mergeConfigurations(existingConfig, newConfig) {
    // Merge scheduled messages
    if (newConfig.scheduledMessages && newConfig.scheduledMessages.length > 0) {
      if (!existingConfig.scheduledMessages) {
        existingConfig.scheduledMessages = [];
      }
      
      // Add new scheduled messages with unique IDs
      newConfig.scheduledMessages.forEach(newMessage => {
        // Prefix ID with config name to ensure uniqueness
        const prefixedId = `${newConfig.name}-${newMessage.id}`;
        const messageToAdd = {
          ...newMessage,
          id: prefixedId,
          _originalConfigName: newConfig.name
        };
        existingConfig.scheduledMessages.push(messageToAdd);
      });
    }

    // Merge response rules
    if (newConfig.responseRules && newConfig.responseRules.length > 0) {
      if (!existingConfig.responseRules) {
        existingConfig.responseRules = [];
      }
      
      // Add new response rules with unique IDs
      newConfig.responseRules.forEach(newRule => {
        // Prefix ID with config name to ensure uniqueness
        const prefixedId = `${newConfig.name}-${newRule.id}`;
        const ruleToAdd = {
          ...newRule,
          id: prefixedId,
          _originalConfigName: newConfig.name
        };
        existingConfig.responseRules.push(ruleToAdd);
      });
    }

    // Merge connection behavior (if the existing one doesn't have it)
    if (newConfig.connectionBehavior && !existingConfig.connectionBehavior) {
      existingConfig.connectionBehavior = newConfig.connectionBehavior;
    }

    // Update metadata to reflect the merge
    if (!existingConfig._mergedConfigs) {
      existingConfig._mergedConfigs = [existingConfig.name];
    }
    existingConfig._mergedConfigs.push(newConfig.name);

    // Update description to reflect merged nature
    if (newConfig.description) {
      if (existingConfig.description) {
        existingConfig.description += ` + ${newConfig.description}`;
      } else {
        existingConfig.description = newConfig.description;
      }
    }

    // Successfully merged configurations
  }

  /**
   * Merge configuration into master configuration with subdirectory prefixing
   * @param {Object} masterConfig - The master configuration to merge into
   * @param {Object} config - The configuration to merge from
   * @param {string} subdirName - The subdirectory name for prefixing
   */
  mergeConfigIntoMaster(masterConfig, config, subdirName) {
    // Merge scheduled messages
    if (config.scheduledMessages && config.scheduledMessages.length > 0) {
      config.scheduledMessages.forEach(message => {
        // Prefix ID with subdirectory and config name
        const prefixedId = `${subdirName}-${config.name}-${message.id}`;
        const messageToAdd = {
          ...message,
          id: prefixedId,
          _originalConfigName: config.name,
          _subdirectory: subdirName
        };
        masterConfig.scheduledMessages.push(messageToAdd);
      });
    }

    // Merge response rules
    if (config.responseRules && config.responseRules.length > 0) {
      config.responseRules.forEach(rule => {
        // Prefix ID with subdirectory and config name
        const prefixedId = `${subdirName}-${config.name}-${rule.id}`;
        const ruleToAdd = {
          ...rule,
          id: prefixedId,
          _originalConfigName: config.name,
          _subdirectory: subdirName
        };
        masterConfig.responseRules.push(ruleToAdd);
      });
    }

    // Use first connection behavior found
    if (config.connectionBehavior && !masterConfig.connectionBehavior) {
      masterConfig.connectionBehavior = config.connectionBehavior;
    }

    // Track merged configurations
    masterConfig._mergedConfigs.push(`${subdirName}/${config.name}`);

    // Update description
    if (config.description) {
      if (masterConfig.description === 'Merged configuration from all subdirectories') {
        masterConfig.description = `${subdirName}: ${config.description}`;
      } else {
        masterConfig.description += ` + ${subdirName}: ${config.description}`;
      }
    }

  }

  /**
   * Merge API configuration into master configuration with subdirectory prefixing
   * @param {Object} masterConfig - The master configuration to merge into
   * @param {Object} config - The API configuration to merge from
   * @param {string} subdirName - The subdirectory name for prefixing
   */
  mergeApiConfigIntoMaster(masterConfig, config, subdirName) {
    // Merge mappings
    if (config.mappings && config.mappings.length > 0) {
      config.mappings.forEach((mapping, index) => {
        // Create prefixed ID
        const mappingId = mapping.id || `mapping-${index}`;
        const prefixedId = `${subdirName}-${config.name}-${mappingId}`;
        
        const mappingToAdd = {
          ...mapping,
          id: prefixedId,
          _originalConfigName: config.name,
          _subdirectory: subdirName
        };
        masterConfig.mappings.push(mappingToAdd);
      });
    }

    // Track merged configurations
    masterConfig._mergedConfigs.push(`${subdirName}/${config.name}`);

    // Update description
    if (config.description) {
      if (masterConfig.description === 'Merged API configuration from all sources') {
        masterConfig.description = `${subdirName}: ${config.description}`;
      } else {
        masterConfig.description += ` + ${subdirName}: ${config.description}`;
      }
    }

  }

  /**
   * Get configuration by name
   * @param {string} name - Configuration name
   * @returns {Object|null} Configuration or null if not found
   */
  getConfiguration(name) {
    return this.configs.get(name) || null;
  }

  /**
   * Get all configurations
   * @returns {Array} All loaded configurations
   */
  getAllConfigurations() {
    return Array.from(this.configs.values());
  }

  /**
   * Reload a specific configuration
   * @param {string} name - Configuration name to reload
   * @returns {Object|null} Reloaded configuration
   */
  async reloadConfiguration(name) {
    const config = this.configs.get(name);
    if (!config || !config._metadata) {
      this.logger.warn({ name }, 'Configuration not found or missing metadata');
      return null;
    }

    const reloaded = await this.loadSingleConfiguration(
      config._metadata.filePath,
      config._metadata.fileName
    );

    if (reloaded) {
      this.configs.set(name, reloaded);
      this.logger.info({ name }, 'Configuration reloaded');
    }

    return reloaded;
  }

  /**
   * Watch configuration directory for changes
   * @param {string} configDir - Directory to watch
   * @param {Function} onChange - Callback for configuration changes
   */
  watchConfigurations(configDir = 'mocks', onChange) {
    // This is a placeholder for file watching functionality
    // Could be implemented with chokidar or fs.watch
    this.logger.info({ configDir }, 'Configuration watching not implemented yet');
  }
}

module.exports = ConfigurationManager;