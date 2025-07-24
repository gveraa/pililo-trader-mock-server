const fastify = require('fastify');
const websocketPlugin = require('@fastify/websocket');
const ConfigurationManager = require('./modules/ConfigurationManager');
const ConnectionManager = require('./modules/ConnectionManager');
const MessageHandler = require('./modules/MessageHandler');
const SchedulerService = require('./modules/SchedulerService');
const TemplateEngine = require('./modules/TemplateEngine');
const ApiRequestMatcher = require('./modules/ApiRequestMatcher');
const ApiResponseHandler = require('./modules/ApiResponseHandler');

class MockServer {
  constructor(logger) {
    this.logger = logger;
    
    // Initialize modules
    this.templateEngine = new TemplateEngine(logger);
    this.configManager = new ConfigurationManager(logger);
    this.connectionManager = new ConnectionManager(logger);
    this.messageHandler = new MessageHandler(logger, this.templateEngine);
    this.schedulerService = new SchedulerService(logger, this.templateEngine);
    this.apiRequestMatcher = new ApiRequestMatcher(logger);
    this.apiResponseHandler = new ApiResponseHandler(logger, this.templateEngine);
    
    // Server management
    this.activeServers = new Map();
    this.loadedMocks = {
      ws: {},
      api: {}
    };
    this.failedMocks = {
      ws: {},
      api: {}
    };
    
    // Setup event listeners
    this.setupEventListeners();
  }

  /**
   * Initialize the mock server system
   * @param {Object} options - Initialization options
   */
  async initialize(options = {}) {
    try {
      // Load schema
      await this.configManager.loadSchema(options.schemaPath);
      
      // Load configurations
      const loadResults = await this.configManager.loadConfigurations(
        options.configDir || 'mocks',
        {
          stopOnError: options.stopOnError || false,
          validateOnly: options.validateOnly || false
        }
      );
      
      // Check if any configurations were loaded
      if (loadResults.summary.loaded === 0) {
        if (loadResults.summary.total === 0) {
          throw new Error('No configuration files found in the mocks directory');
        } else {
          throw new Error(`All ${loadResults.summary.total} configuration files failed validation`);
        }
      }
      
      // Log validation summary
      if (loadResults.summary.failed > 0) {
        this.logger.warn({
          loaded: loadResults.summary.loaded,
          failed: loadResults.summary.failed,
          errors: loadResults.summary.errors
        }, 'Some configurations failed to load');
      }
      
      // Organize loaded mocks by type
      this.organizeMocksByType(loadResults.configurations);
      
      // Organize failed mocks
      if (loadResults.summary.errors && loadResults.summary.errors.length > 0) {
        this.organizeFailedMocks(loadResults.summary.errors);
      }
      
      this.logger.info({
        configurationsLoaded: loadResults.summary.loaded,
        configurationsFailed: loadResults.summary.failed,
        wsMocks: Object.keys(this.loadedMocks.ws).length,
        apiMocks: Object.keys(this.loadedMocks.api).length,
        failedWsMocks: Object.keys(this.failedMocks.ws).length,
        failedApiMocks: Object.keys(this.failedMocks.api).length
      }, `📋 Initialization complete: ${loadResults.summary.loaded} valid configurations loaded`);
      
      return loadResults.configurations;
    } catch (error) {
      this.logger.error({
        error: error.message
      }, 'Failed to initialize mock server');
      throw error;
    }
  }

  /**
   * Organize mocks by type for status endpoint
   * @param {Array} configs - Loaded configurations
   */
  organizeMocksByType(configs) {
    configs.forEach(config => {
      if (config.type === 'ws') {
        // For merged configs, extract individual file operations
        if (config._mergedConfigs && config._mergedConfigs.length > 0) {
          // Process each merged config
          config._mergedConfigs.forEach(mergedPath => {
            const operations = [];
            const seenDescriptors = new Set(); // Track unique descriptors
            
            // Extract operations for this specific merged config
            if (config.scheduledMessages) {
              config.scheduledMessages
                .filter(msg => {
                  // More precise filtering
                  const msgPath = msg._subdirectory ? `${msg._subdirectory}/${msg._originalConfigName}` : msg._originalConfigName;
                  return msgPath === mergedPath;
                })
                .forEach(msg => {
                  // Smart ID extraction - if the original ID is too generic, include more context
                  const idParts = msg.id.split('-');
                  let displayId = idParts[idParts.length - 1]; // Start with just the last part
                  
                  // If the ID is very short or generic, include the previous part for context
                  if (displayId.length <= 3 && idParts.length > 1) {
                    displayId = `${idParts[idParts.length - 2]}-${displayId}`;
                  }
                  
                  const interval = msg.interval ? `@${msg.interval}ms` : '';
                  let descriptor = `scheduled:${displayId}${interval}`;
                  // Only add if not already seen (deduplication)
                  if (!seenDescriptors.has(descriptor)) {
                    operations.push(descriptor);
                    seenDescriptors.add(descriptor);
                  }
                });
            }
            
            if (config.responseRules) {
              config.responseRules
                .filter(rule => rule._subdirectory && rule._originalConfigName && 
                       `${rule._subdirectory}/${rule._originalConfigName}` === mergedPath)
                .forEach(rule => {
                  const originalId = rule.id.split('-').pop();
                  let matcherInfo = '';
                  
                  if (rule.matcher.type === 'jsonPath') {
                    matcherInfo = `[jsonPath:${rule.matcher.path}=${rule.matcher.value || '*'}]`;
                  } else if (rule.matcher.type === 'contains' || rule.matcher.type === 'exact') {
                    const value = typeof rule.matcher.value === 'string' ? 
                      rule.matcher.value.substring(0, 20) : 
                      JSON.stringify(rule.matcher.value).substring(0, 20);
                    matcherInfo = `[${rule.matcher.type}:${value}${value.length >= 20 ? '...' : ''}]`;
                  } else if (rule.matcher.type === 'regex') {
                    matcherInfo = `[regex:${rule.matcher.value.substring(0, 20)}${rule.matcher.value.length > 20 ? '...' : ''}]`;
                  } else {
                    matcherInfo = `[${rule.matcher.type}]`;
                  }
                  
                  operations.push(`rule:${originalId}${matcherInfo}`);
                });
            }
            
            if (operations.length > 0) {
              this.loadedMocks.ws[mergedPath] = operations;
            }
          });
        } else {
          // Single config (not merged)
          const operations = [];
          if (config.scheduledMessages) {
            config.scheduledMessages.forEach(msg => {
              const interval = msg.interval ? `@${msg.interval}ms` : '';
              let descriptor = `scheduled:${msg.id}${interval}`;
              operations.push(descriptor);
            });
          }
          if (config.responseRules) {
            config.responseRules.forEach(rule => {
              let matcherInfo = '';
              
              if (rule.matcher.type === 'jsonPath') {
                matcherInfo = `[jsonPath:${rule.matcher.path}=${rule.matcher.value || '*'}]`;
              } else if (rule.matcher.type === 'contains' || rule.matcher.type === 'exact') {
                const value = typeof rule.matcher.value === 'string' ? 
                  rule.matcher.value.substring(0, 20) : 
                  JSON.stringify(rule.matcher.value).substring(0, 20);
                matcherInfo = `[${rule.matcher.type}:${value}${value.length >= 20 ? '...' : ''}]`;
              } else if (rule.matcher.type === 'regex') {
                matcherInfo = `[regex:${rule.matcher.value.substring(0, 20)}${rule.matcher.value.length > 20 ? '...' : ''}]`;
              } else {
                matcherInfo = `[${rule.matcher.type}]`;
              }
              
              operations.push(`rule:${rule.id}${matcherInfo}`);
            });
          }
          const key = config._metadata ? 
            config._metadata.fileName.replace('.json', '') : 
            config.name;
          this.loadedMocks.ws[key] = operations;
        }
      } else if (config.type === 'api') {
        // For merged configs, extract individual file endpoints
        if (config._mergedConfigs && config._mergedConfigs.length > 0) {
          // Process each merged config
          config._mergedConfigs.forEach(mergedPath => {
            const endpoints = [];
            
            // Extract endpoints for this specific merged config
            if (config.mappings) {
              config.mappings
                .filter(mapping => mapping._subdirectory && mapping._originalConfigName && 
                       `${mapping._subdirectory}/${mapping._originalConfigName}` === mergedPath)
                .forEach(mapping => {
                  const method = mapping.request.method || 'ANY';
                  const path = mapping.request.urlPath || mapping.request.urlPathPattern || '/*';
                  endpoints.push(`${method} ${path}`);
                });
            }
            
            if (endpoints.length > 0) {
              this.loadedMocks.api[mergedPath] = endpoints;
            }
          });
        } else {
          // Single config (not merged)
          const endpoints = [];
          if (config.mappings) {
            config.mappings.forEach(mapping => {
              const method = mapping.request.method || 'ANY';
              const path = mapping.request.urlPath || mapping.request.urlPathPattern || '/*';
              endpoints.push(`${method} ${path}`);
            });
          }
          const key = config._metadata ? 
            config._metadata.fileName.replace('.json', '') : 
            config.name;
          this.loadedMocks.api[key] = endpoints;
        }
      }
    });
  }

  /**
   * Organize failed mocks by type for status endpoint
   * @param {Array} errors - Failed configuration errors
   */
  organizeFailedMocks(errors) {
    errors.forEach(error => {
      const key = error.file.replace('.json', '');
      const failureDetails = error.errors || ['Unknown error'];
      
      if (error.type === 'ws') {
        this.failedMocks.ws[key] = failureDetails;
      } else if (error.type === 'api') {
        this.failedMocks.api[key] = failureDetails;
      } else {
        // Unknown type - try to determine from file path/name
        if (error.file.toLowerCase().includes('ws') || error.file.toLowerCase().includes('websocket')) {
          this.failedMocks.ws[key] = failureDetails;
        } else if (error.file.toLowerCase().includes('api')) {
          this.failedMocks.api[key] = failureDetails;
        } else {
          // Default to API for unknown types
          this.failedMocks.api[key] = failureDetails;
        }
      }
    });
  }

  /**
   * Start all configured mock servers
   */
  async startAll() {
    const configs = this.configManager.getAllConfigurations();
    
    if (configs.length === 0) {
      this.logger.warn('No configurations found to start');
      return;
    }
    
    // Create a single Fastify server
    const server = await this.createServer();
    
    // Register all configurations
    for (const config of configs) {
      if (config.type === 'ws') {
        this.registerWebSocketHandlers(server, config);
      } else if (config.type === 'api') {
        this.registerApiHandlers(server, config);
      }
    }
    
    // Add built-in endpoints
    this.registerBuiltInEndpoints(server);
    
    // Start the server on fixed port 8080
    await server.listen({ 
      port: 8080, 
      host: '0.0.0.0'
    });
    
    // Store server reference
    this.activeServers.set('main', server);
    
    // Start scheduled messages for WebSocket configs
    configs.filter(c => c.type === 'ws').forEach(config => {
      this.schedulerService.startScheduledMessages(config, (configName, message, options) => {
        return this.connectionManager.broadcast(configName, message, options);
      });
    });
    
    this.logger.info({
      port: 8080,
      wsConfigs: configs.filter(c => c.type === 'ws').length,
      apiConfigs: configs.filter(c => c.type === 'api').length
    }, '🚀 Mock server started on port 8080');
  }

  /**
   * Create Fastify server instance
   */
  async createServer() {
    const server = fastify({
      logger: {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname'
          }
        }
      }
    });

    // Register WebSocket plugin
    await server.register(websocketPlugin, {
      options: {
        maxPayload: 1048576, // 1MB
        clientTracking: true
      }
    });

    return server;
  }

  /**
   * Register WebSocket handlers for a configuration
   */
  registerWebSocketHandlers(server, config) {
    server.register(async (fastify) => {
      fastify.get('/ws', { websocket: true }, (connection, req) => {
        this.handleNewConnection(connection, req, config);
      });
    });
  }

  /**
   * Register API handlers for a configuration
   */
  registerApiHandlers(server, config) {
    if (!config.mappings) return;

    config.mappings.forEach((mapping, index) => {
      if (mapping.enabled !== false) { // Default to enabled
        const method = (mapping.request.method || 'GET').toLowerCase();
        const path = mapping.request.urlPath || mapping.request.urlPathPattern;
        
        if (!path) {
          this.logger.warn({
            config: config.name,
            mappingIndex: index
          }, 'API mapping missing URL path');
          return;
        }

        // Create route handler
        const handler = async (request, reply) => {
          // Check if request matches all criteria
          const matches = await this.apiRequestMatcher.matches(request, mapping.request);
          
          if (matches) {
            this.logger.info({
              method: request.method,
              path: request.url,
              config: config.name,
              mappingId: mapping.id || index
            }, '✓ API request matched');
            
            // Process response
            await this.apiResponseHandler.sendResponse(reply, mapping.response, { request });
          } else {
            // Continue to next handler
            return;
          }
        };

        // Register route
        try {
          if (mapping.request.urlPathPattern) {
            // Convert pattern to Fastify route format
            const routePath = this.convertPatternToRoute(mapping.request.urlPathPattern);
            server[method](routePath, handler);
          } else {
            server[method](path, handler);
          }
          
          this.logger.info({
            method: method.toUpperCase(),
            path: path,
            config: config.name
          }, 'Registered API endpoint');
        } catch (error) {
          this.logger.error({
            error: error.message,
            method,
            path,
            config: config.name
          }, 'Failed to register API endpoint');
        }
      }
    });
  }

  /**
   * Convert URL pattern to Fastify route format
   */
  convertPatternToRoute(pattern) {
    // Convert regex groups to Fastify parameters
    // Example: /ripio/ticker/([A-Z]+_[A-Z]+) -> /ripio/ticker/:pair
    return pattern.replace(/\([^)]+\)/g, ':param');
  }

  /**
   * Register built-in endpoints
   */
  registerBuiltInEndpoints(server) {
    // Health check endpoint
    server.get('/health', async (request, reply) => {
      const stats = this.connectionManager.getStats();
      return {
        status: 'healthy',
        connections: stats.currentConnections,
        uptime: process.uptime()
      };
    });

    // Status endpoint showing all loaded mocks
    server.get('/status', async (request, reply) => {
      const status = {
        ws: this.loadedMocks.ws,
        api: {
          ...this.loadedMocks.api,
          '_built-in': [
            'GET /health',
            'GET /status',
            'GET /status/:code',
            'GET /timeout/:seconds'
          ]
        }
      };
      
      // Add failed configurations if any exist
      if (Object.keys(this.failedMocks.ws).length > 0) {
        status.ws.failed = this.failedMocks.ws;
      }
      if (Object.keys(this.failedMocks.api).length > 0) {
        status.api.failed = this.failedMocks.api;
      }
      
      return status;
    });

    // Status code test endpoints
    server.get('/status/:code', async (request, reply) => {
      const code = parseInt(request.params.code);
      if (code >= 100 && code <= 599) {
        reply.code(code).send({
          status: code,
          message: `Test response with status ${code}`
        });
      } else {
        reply.code(400).send({
          error: 'Invalid status code',
          message: 'Status code must be between 100 and 599'
        });
      }
    });

    // Timeout test endpoints
    server.get('/timeout/:seconds', async (request, reply) => {
      const seconds = parseInt(request.params.seconds);
      if (seconds >= 0 && seconds <= 60) {
        await new Promise(resolve => setTimeout(resolve, seconds * 1000));
        reply.send({
          message: `Response after ${seconds} second(s) delay`
        });
      } else {
        reply.code(400).send({
          error: 'Invalid timeout',
          message: 'Timeout must be between 0 and 60 seconds'
        });
      }
    });

  }

  /**
   * Handle new WebSocket connection
   * @param {Object} connection - WebSocket connection
   * @param {Object} req - HTTP request
   * @param {Object} config - Server configuration
   */
  handleNewConnection(connection, req, config) {
    // Register connection
    const connectionId = this.connectionManager.addConnection(connection, config, {
      headers: req.headers,
      query: req.query,
      ip: req.ip
    });

    if (!connectionId) {
      // Connection was rejected (e.g., limit exceeded)
      return;
    }

    const connectionInfo = this.connectionManager.getConnection(connectionId);

    // Send welcome message if configured
    if (config.connectionBehavior?.onConnect) {
      setTimeout(() => {
        const welcomeMessage = this.templateEngine.process(
          config.connectionBehavior.onConnect.message,
          { connection: connectionInfo }
        );
        this.connectionManager.sendToConnection(connectionId, welcomeMessage);
      }, config.connectionBehavior.onConnect.delay || 0);
    }

    // Handle incoming messages
    connection.socket.on('message', async (rawMessage) => {
      try {
        this.connectionManager.recordMessageReceived(connectionId);
        
        // Log client interaction
        let parsedMessage;
        try {
          parsedMessage = JSON.parse(rawMessage.toString());
        } catch {
          parsedMessage = rawMessage.toString();
        }
        
        this.logger.info({
          connectionId,
          configName: config.name,
          clientMessage: parsedMessage
        }, '← Client message received');
        
        const matchedRules = await this.messageHandler.handleIncomingMessage(
          connectionId,
          rawMessage,
          config,
          connectionInfo
        );

        if (matchedRules.length > 0) {
          this.logger.info({
            connectionId,
            matchedRules: matchedRules.map(r => r.rule.id)
          }, `Matched ${matchedRules.length} rule(s)`);
        }
      } catch (error) {
        this.logger.error({
          connectionId,
          error: error.message
        }, 'Error processing message');
      }
    });

    // Handle disconnection
    connection.socket.on('close', () => {
      this.connectionManager.removeConnection(connectionId);
      this.messageHandler.clearHistory(connectionId);
    });

    // Handle errors
    connection.socket.on('error', (error) => {
      this.logger.error({
        connectionId,
        error: error.message
      }, 'WebSocket error');
    });
  }

  /**
   * Setup event listeners between modules
   */
  setupEventListeners() {
    // Listen for response ready events from message handler
    this.messageHandler.on('response:ready', ({ connectionId, message, ruleId }) => {
      const success = this.connectionManager.sendToConnection(connectionId, message);
      if (success) {
        this.logger.info({
          connectionId,
          ruleId,
          serverMessage: message
        }, '→ Server response sent');
      }
    });

    // Listen for connection events
    this.connectionManager.on('connection:added', (connectionInfo) => {
      this.logger.info({
        connectionId: connectionInfo.id,
        configName: connectionInfo.config.name,
        remoteAddress: connectionInfo.metadata.remoteAddress
      }, '🔗 Client connected');
    });

    this.connectionManager.on('connection:removed', (connectionInfo) => {
      this.logger.info({
        connectionId: connectionInfo.id,
        configName: connectionInfo.config.name,
        duration: Date.now() - connectionInfo.connectedAt.getTime(),
        messagesSent: connectionInfo.messageCount.sent,
        messagesReceived: connectionInfo.messageCount.received
      }, '❌ Client disconnected');
    });

    // Listen for message sent events from connection manager
    this.connectionManager.on('message:sent', ({ connectionId, message }) => {
      this.logger.info({
        connectionId,
        serverMessage: JSON.parse(message)
      }, '→ Server message sent');
    });

    // Listen for scheduler events
    this.schedulerService.on('message:executed', ({ taskKey, result }) => {
      if (result.successful > 0) {
        this.logger.info({
          taskKey,
          sent: result.successful,
          failed: result.failed
        }, '📡 Scheduled message broadcast');
      }
    });
  }

  /**
   * Stop all mock servers
   */
  async stopAll() {
    this.logger.info('Stopping all mock servers...');
    
    // Stop all scheduled tasks
    this.schedulerService.stopAll();
    
    // Close all connections
    this.connectionManager.closeAllConnections();
    
    // Stop all servers
    const stopPromises = [];
    for (const [name, server] of this.activeServers) {
      stopPromises.push(
        server.close()
          .then(() => this.logger.info({ name }, 'Server stopped'))
          .catch(err => this.logger.error({ name, error: err.message }, 'Error stopping server'))
      );
    }
    
    await Promise.all(stopPromises);
    this.activeServers.clear();
    
    this.logger.info('All mock servers stopped');
  }

  /**
   * Get runtime information
   * @returns {Object} Runtime information
   */
  getRuntimeInfo() {
    const info = {
      servers: {},
      global: {
        totalConnections: 0,
        totalServers: this.activeServers.size,
        uptime: process.uptime()
      }
    };

    for (const [name, server] of this.activeServers) {
      const connectionStats = this.connectionManager.getStats();
      const schedulerStatus = this.schedulerService.getStatus();

      info.servers[name] = {
        port: 8080,
        connections: connectionStats,
        scheduler: schedulerStatus,
        mocks: this.loadedMocks
      };

      info.global.totalConnections += connectionStats.currentConnections;
    }

    return info;
  }

  /**
   * Perform cleanup operations
   * @param {Object} options - Cleanup options
   */
  async cleanup(options = {}) {
    const { 
      clearHistory = true,
      closeStaleConnections = true,
      maxIdleTime = 300000 // 5 minutes
    } = options;

    this.logger.info('Performing cleanup operations...');

    if (closeStaleConnections) {
      const closed = this.connectionManager.cleanupStaleConnections(maxIdleTime);
      this.logger.info({ closedConnections: closed }, 'Cleaned up stale connections');
    }

    if (clearHistory) {
      this.messageHandler.clearHistory();
      this.schedulerService.clearHistory();
      this.logger.info('Cleared message and scheduler history');
    }
  }
}

module.exports = MockServer;