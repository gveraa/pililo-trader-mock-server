const fastify = require('fastify');
const websocketPlugin = require('@fastify/websocket');
const ConfigurationManager = require('./modules/ConfigurationManager');
const ConnectionManager = require('./modules/ConnectionManager');
const MessageHandler = require('./modules/MessageHandler');
const SchedulerService = require('./modules/SchedulerService');
const FastTemplateEngine = require('./modules/FastTemplateEngine');
const ApiRequestMatcher = require('./modules/ApiRequestMatcher');
const FastApiRequestMatcher = require('./modules/FastApiRequestMatcher');
const ApiResponseHandler = require('./modules/ApiResponseHandler');
const { generateCorrelationId, getMessagePreview, createRequestLog, createResponseLog } = require('./utils/fastLogger');
const { extractPath, optimizeMapping, parseScenarioHeader } = require('./utils/performanceOptimizer');

class MockServer {
  constructor(logger) {
    this.logger = logger;
    
    // Initialize modules
    this.templateEngine = new FastTemplateEngine(logger);
    this.configManager = new ConfigurationManager(logger);
    this.connectionManager = new ConnectionManager(logger);
    this.messageHandler = new MessageHandler(logger, this.templateEngine);
    this.schedulerService = new SchedulerService(logger, this.templateEngine);
    this.apiRequestMatcher = new ApiRequestMatcher(logger);
    this.fastApiMatcher = new FastApiRequestMatcher(logger);
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
    
    // Track registered API routes and mappings
    this.registeredApiRoutes = new Map(); // key: 'METHOD /path', value: array of mappings
    this.apiMappings = []; // All API mappings in order
    
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
      
      // Organize loaded mocks by type
      this.organizeMocksByType(loadResults.configurations);
      
      // Organize failed mocks
      if (loadResults.summary.errors && loadResults.summary.errors.length > 0) {
        this.organizeFailedMocks(loadResults.summary.errors);
      }
      
      this.logger.info({
        loaded: loadResults.summary.loaded,
        failed: loadResults.summary.failed
      }, 'Initialization complete');
      
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
                    if (rule.matcher.value !== undefined) {
                      const value = typeof rule.matcher.value === 'string' ? 
                        rule.matcher.value.substring(0, 20) : 
                        JSON.stringify(rule.matcher.value).substring(0, 20);
                      matcherInfo = `[${rule.matcher.type}:${value}${value.length >= 20 ? '...' : ''}]`;
                    } else {
                      matcherInfo = `[${rule.matcher.type}:undefined]`;
                    }
                  } else if (rule.matcher.type === 'regex') {
                    if (rule.matcher.value !== undefined) {
                      matcherInfo = `[regex:${rule.matcher.value.substring(0, 20)}${rule.matcher.value.length > 20 ? '...' : ''}]`;
                    } else {
                      matcherInfo = `[regex:undefined]`;
                    }
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
                if (rule.matcher.value !== undefined) {
                  const value = typeof rule.matcher.value === 'string' ? 
                    rule.matcher.value.substring(0, 20) : 
                    JSON.stringify(rule.matcher.value).substring(0, 20);
                  matcherInfo = `[${rule.matcher.type}:${value}${value.length >= 20 ? '...' : ''}]`;
                } else {
                  matcherInfo = `[${rule.matcher.type}:undefined]`;
                }
              } else if (rule.matcher.type === 'regex') {
                if (rule.matcher.value !== undefined) {
                  matcherInfo = `[regex:${rule.matcher.value.substring(0, 20)}${rule.matcher.value.length > 20 ? '...' : ''}]`;
                } else {
                  matcherInfo = `[regex:undefined]`;
                }
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
        // API configs are not merged - each is loaded individually
        const endpoints = [];
        if (config.mappings) {
          config.mappings.forEach(mapping => {
            const method = mapping.request.method || 'ANY';
            const path = mapping.request.urlPath || mapping.request.urlPathPattern || '/*';
            
            // Include scenario information if present
            let endpoint = `${method} ${path}`;
            if (mapping.request.headers?.['X-Mock-Scenario']?.equals) {
              endpoint += ` [scenario: ${mapping.request.headers['X-Mock-Scenario'].equals}]`;
            }
            if (mapping.id) {
              endpoint += ` (${mapping.id})`;
            }
            
            endpoints.push(endpoint);
          });
        }
        const key = config._location || config.name;
        this.loadedMocks.api[key] = endpoints;
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
    
    // Sort API mappings by priority after all are registered
    this.sortApiMappingsByPriority();
    
    // Add built-in endpoints first (they have highest priority)
    this.registerBuiltInEndpoints(server);
    
    // Register a catch-all route for API requests
    this.registerCatchAllRoute(server);
    
    // Add default handler for unmatched routes
    server.setNotFoundHandler(async (request, reply) => {
      this.logger.warn({
        method: request.method,
        url: request.url,
        headers: request.headers
      }, 'No API mapping matched request');
      
      reply.code(404).send({
        error: 'Not Found',
        message: 'No mock mapping found for this request',
        method: request.method,
        path: request.url
      });
    });
    
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
    }, 'Mock server started on port 8080');
  }

  /**
   * Create Fastify server instance
   */
  async createServer() {
    const server = fastify({
      logger: {
        level: 'error', // Only log errors from Fastify itself
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname,reqId,req,res,responseTime'
          }
        }
      },
      disableRequestLogging: true, // Disable Fastify's request logging
      exposeHeadRoutes: false  // Disable automatic HEAD route generation
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
    
    // Track failed mappings for this config
    const failedMappings = [];

    config.mappings.forEach((mapping, index) => {
      if (mapping.enabled !== false) { // Default to enabled
        const method = (mapping.request.method || 'GET').toUpperCase();
        const path = mapping.request.urlPath || mapping.request.urlPathPattern;
        
        if (!path) {
          this.logger.warn({
            config: config.name,
            mappingIndex: index
          }, 'API mapping missing URL path');
          return;
        }
        
        // Store mapping with config info and priority
        const enrichedMapping = {
          ...mapping,
          _configName: config.name,
          _configLocation: config._location || config.name,
          _mappingIndex: index,
          _priority: this.calculateMappingPriority(mapping)
        };
        
        // Optimize the mapping for fast matching
        const optimizedMapping = optimizeMapping(enrichedMapping);
        
        // Add to global mappings list
        this.apiMappings.push(optimizedMapping);
      }
    });
    
    // If there were failures, add to failedMocks
    if (failedMappings.length > 0) {
      const configKey = config._location || config.name;
      if (!this.failedMocks.api[configKey]) {
        this.failedMocks.api[configKey] = [];
      }
      this.failedMocks.api[configKey].push(...failedMappings);
    }
  }

  /**
   * Convert URL pattern to Fastify route format
   */
  convertPatternToRoute(pattern) {
    // Convert common regex patterns to Fastify wildcard format
    // Examples:
    // /ripio/.* -> /ripio/*
    // /ripio/users.* -> /ripio/users*
    // /ripio/ticker/([A-Z]+_[A-Z]+) -> /ripio/ticker/:param
    
    // First, replace .* at the end with *
    let route = pattern.replace(/\.\*$/, '*');
    
    // Replace .* in the middle with *
    route = route.replace(/\.\*/g, '*');
    
    // Convert regex groups to Fastify parameters
    route = route.replace(/\([^)]+\)/g, ':param');
    
    return route;
  }

  /**
   * Calculate priority for a mapping based on path specificity
   * Lower number = higher priority
   */
  calculateMappingPriority(mapping) {
    const path = mapping.request.urlPath || mapping.request.urlPathPattern;
    
    // Priority 1: Exact paths (urlPath)
    if (mapping.request.urlPath) {
      return 1;
    }
    
    // Priority 2: Pattern paths with specific segments
    if (mapping.request.urlPathPattern) {
      // Count wildcards and regex patterns
      const wildcardCount = (path.match(/\.\*/g) || []).length;
      const regexGroupCount = (path.match(/\([^)]+\)/g) || []).length;
      const pathSegments = path.split('/').length;
      
      // More specific paths (more segments, fewer wildcards) get higher priority
      // Base priority 100 for patterns, plus penalties for wildcards
      return 100 + (wildcardCount * 100) + (regexGroupCount * 10) - pathSegments;
    }
    
    // Default lowest priority
    return 1000;
  }

  /**
   * Sort API mappings by priority
   */
  sortApiMappingsByPriority() {
    this.apiMappings.sort((a, b) => {
      const priorityA = this.calculateMappingPriority(a);
      const priorityB = this.calculateMappingPriority(b);
      
      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }
      
      // If same priority, maintain original order
      return a._mappingIndex - b._mappingIndex;
    });
    
    this.logger.debug({
      mappingCount: this.apiMappings.length,
      priorities: this.apiMappings.map(m => ({
        path: m.request.urlPath || m.request.urlPathPattern,
        priority: this.calculateMappingPriority(m)
      }))
    }, 'API mappings sorted by priority');
  }

  /**
   * Try to match request against all API mappings
   */
  async matchApiRequest(request, reply) {
    const method = request.method.toUpperCase();
    const urlPath = extractPath(request.url);
    
    // Generate correlation ID
    const correlationId = generateCorrelationId();
    request.correlationId = correlationId;
    
    // Try each mapping in priority order
    for (const mapping of this.apiMappings) {
      // Use fast matcher for optimized mappings
      const matches = mapping._optimized 
        ? this.fastApiMatcher.matches(request, mapping, urlPath)
        : await this.apiRequestMatcher.matches(request, mapping.request);
      
      if (matches) {
        // Log simple request received with scenario
        const scenario = request.headers['x-mock-scenario'];
        this.logger.info(createRequestLog(request.method, request.url, correlationId, scenario), 
          scenario ? `→ [${correlationId}] ${request.method} ${request.url} [${scenario}]` : `→ [${correlationId}] ${request.method} ${request.url}`);
        
        this.logger.debug({
          method: request.method,
          path: request.url,
          matchedPath: mapping.request.urlPath || mapping.request.urlPathPattern,
          priority: this.calculateMappingPriority(mapping),
          mappingId: mapping.id || mapping._mappingIndex,
          configName: mapping._configName,
          scenario: mapping.request.headers?.['X-Mock-Scenario']?.equals || 
                   mapping.request.headers?.['X-Mock-Scenario']?.matches
        }, 'API request matched with priority');
        
        // Check for dynamic scenario patterns in header
        let responseConfig = { ...mapping.response };
        const scenarioHeader = request.headers['x-mock-scenario'];
        const scenarioResult = parseScenarioHeader(scenarioHeader);
        
        if (scenarioResult) {
          switch (scenarioResult.type) {
            case 'timeout':
            case 'slow':
              responseConfig.delay = scenarioResult.value;
              this.logger.debug({
                scenario: scenarioHeader,
                delayMs: responseConfig.delay
              }, `Dynamic ${scenarioResult.type} applied from scenario header`);
              break;
            
            case 'error':
              responseConfig.status = scenarioResult.value;
              // Provide a default error body if none exists
              if (!responseConfig.jsonBody && !responseConfig.body) {
                responseConfig.jsonBody = {
                  error: `HTTP ${scenarioResult.value}`,
                  message: this.getDefaultErrorMessage(scenarioResult.value),
                  timestamp: "{{timestamp}}"
                };
              }
              this.logger.debug({
                scenario: scenarioHeader,
                statusCode: scenarioResult.value
              }, 'Dynamic error code applied from scenario header');
              break;
          }
        }
        
        // Process response
        await this.apiResponseHandler.sendResponse(reply, responseConfig, { request });
        
        // Log simple response sent with correlation ID
        this.logger.info(createResponseLog(request.method, request.url, correlationId, responseConfig.status || 200),
          `← [${correlationId}] ${responseConfig.status || 200} ${request.method} ${request.url}`);
        
        return true;
      }
    }
    
    return false;
  }

  /**
   * Register catch-all route for priority-based API matching
   */
  registerCatchAllRoute(server) {
    // Register routes for each HTTP method
    const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
    
    methods.forEach(method => {
      server[method.toLowerCase()]('/*', async (request, reply) => {
        const matched = await this.matchApiRequest(request, reply);
        if (!matched) {
          // Let it fall through to the not found handler
          reply.callNotFound();
        }
      });
    });
  }

  /**
   * Register built-in endpoints
   */
  registerBuiltInEndpoints(server) {
    // Health check endpoint
    server.get('/health', async (request, reply) => {
      const correlationId = generateCorrelationId();
      this.logger.info(createRequestLog(request.method, request.url, correlationId),
        `→ [${correlationId}] ${request.method} ${request.url}`);
      const stats = this.connectionManager.getStats();
      const response = {
        status: 'healthy',
        connections: stats.currentConnections,
        uptime: process.uptime()
      };
      this.logger.info(createResponseLog(request.method, request.url, correlationId, 200),
        `← [${correlationId}] 200 ${request.method} ${request.url}`);
      return response;
    });

    // Status endpoint showing all loaded mocks
    server.get('/status', async (request, reply) => {
      const correlationId = generateCorrelationId();
      this.logger.info(createRequestLog(request.method, request.url, correlationId),
        `→ [${correlationId}] ${request.method} ${request.url}`);
      const status = {
        ws: this.loadedMocks.ws,
        api: {
          ...this.loadedMocks.api,
          '_built-in': [
            'GET /health',
            'GET /status',
            'GET /status/:code',
            'GET /timeout/:seconds',
            'GET /schema/ws',
            'GET /schema/api'
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
      
      this.logger.info(createResponseLog(request.method, request.url, correlationId, 200),
        `← [${correlationId}] 200 ${request.method} ${request.url}`);
      return status;
    });

    // Schema endpoints
    server.get('/schema/ws', async (request, reply) => {
      if (!this.configManager.wsSchema || !this.configManager.baseSchema) {
        return {
          error: 'WebSocket schema not loaded',
          message: 'Please ensure the schema files are properly loaded'
        };
      }
      
      // Merge base schema properties with WebSocket schema
      const completeSchema = {
        ...this.configManager.wsSchema,
        properties: {
          name: this.configManager.baseSchema.properties.name,
          type: {
            ...this.configManager.baseSchema.properties.type,
            enum: ['ws'],
            description: 'Type must be "ws" for WebSocket mock'
          },
          description: this.configManager.baseSchema.properties.description,
          ...this.configManager.wsSchema.properties
        },
        required: ['name', 'type']
      };
      
      return completeSchema;
    });

    server.get('/schema/api', async (request, reply) => {
      if (!this.configManager.apiSchema || !this.configManager.baseSchema) {
        return {
          error: 'API schema not loaded',
          message: 'Please ensure the schema files are properly loaded'
        };
      }
      
      // Merge base schema properties with API schema
      const completeSchema = {
        ...this.configManager.apiSchema,
        properties: {
          name: this.configManager.baseSchema.properties.name,
          type: {
            ...this.configManager.baseSchema.properties.type,
            enum: ['api'],
            description: 'Type must be "api" for API mock'
          },
          description: this.configManager.baseSchema.properties.description,
          ...this.configManager.apiSchema.properties
        },
        required: ['name', 'type']
      };
      
      return completeSchema;
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
        
        // Generate message correlation ID
        const msgCorrelationId = generateCorrelationId('msg');
        
        // Simple WebSocket request log
        const messagePreview = getMessagePreview(parsedMessage);
        this.logger.info({ 
          type: 'ws-request', 
          connectionId, 
          correlationId: msgCorrelationId 
        }, `→ WS [${connectionId}] [${msgCorrelationId}] ${messagePreview}`);
        
        this.logger.debug({
          connectionId,
          message: parsedMessage
        }, 'Client message received');
        
        const matchedRules = await this.messageHandler.handleIncomingMessage(
          connectionId,
          rawMessage,
          config,
          connectionInfo,
          msgCorrelationId
        );

        // Matching info logged at debug level in MessageHandler
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
    this.messageHandler.on('response:ready', ({ connectionId, message, ruleId, correlationId }) => {
      const success = this.connectionManager.sendToConnection(connectionId, message);
      if (success) {
        // Simple WebSocket response log
        const messagePreview = getMessagePreview(message);
        const corrId = correlationId ? ` [${correlationId}]` : '';
        this.logger.info({ 
          type: 'ws-response', 
          connectionId, 
          correlationId: correlationId || undefined 
        }, `← WS [${connectionId}]${corrId} ${messagePreview}`);
        
        this.logger.debug({
          connectionId,
          ruleId,
          correlationId
        }, 'Server response sent');
      }
    });

    // Listen for connection events
    this.connectionManager.on('connection:added', (connectionInfo) => {
      this.logger.info(`✓ WS Connected [${connectionInfo.id}]`);
      
      this.logger.debug({
        connectionId: connectionInfo.id,
        configName: connectionInfo.config.name
      }, 'Client connected details');
    });

    this.connectionManager.on('connection:removed', (connectionInfo) => {
      const duration = Math.round((Date.now() - connectionInfo.connectedAt.getTime()) / 1000);
      this.logger.info(`✗ WS Disconnected [${connectionInfo.id}] (${duration}s)`);
      
      this.logger.debug({
        connectionId: connectionInfo.id,
        duration: Date.now() - connectionInfo.connectedAt.getTime()
      }, 'Client disconnected details');
    });

    // Listen for message sent events from connection manager
    this.connectionManager.on('message:sent', ({ connectionId, message }) => {
      this.logger.debug({
        connectionId
      }, 'Server message sent');
    });

    // Listen for scheduler events
    this.schedulerService.on('message:executed', ({ taskKey, result }) => {
      if (result.successful > 0) {
        const [configName, messageId] = taskKey.split('::');
        this.logger.info(`↻ WS Scheduled [${messageId}] sent to ${result.successful} client(s)`);
        
        this.logger.debug({
          taskKey,
          sent: result.successful
        }, 'Scheduled message broadcast details');
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
   * Get default error message for HTTP status code
   */
  getDefaultErrorMessage(statusCode) {
    const messages = {
      400: 'Bad Request',
      401: 'Unauthorized',
      402: 'Payment Required',
      403: 'Forbidden',
      404: 'Not Found',
      405: 'Method Not Allowed',
      406: 'Not Acceptable',
      407: 'Proxy Authentication Required',
      408: 'Request Timeout',
      409: 'Conflict',
      410: 'Gone',
      411: 'Length Required',
      412: 'Precondition Failed',
      413: 'Payload Too Large',
      414: 'URI Too Long',
      415: 'Unsupported Media Type',
      416: 'Range Not Satisfiable',
      417: 'Expectation Failed',
      418: "I'm a teapot",
      421: 'Misdirected Request',
      422: 'Unprocessable Entity',
      423: 'Locked',
      424: 'Failed Dependency',
      425: 'Too Early',
      426: 'Upgrade Required',
      428: 'Precondition Required',
      429: 'Too Many Requests',
      431: 'Request Header Fields Too Large',
      451: 'Unavailable For Legal Reasons',
      500: 'Internal Server Error',
      501: 'Not Implemented',
      502: 'Bad Gateway',
      503: 'Service Unavailable',
      504: 'Gateway Timeout',
      505: 'HTTP Version Not Supported',
      506: 'Variant Also Negotiates',
      507: 'Insufficient Storage',
      508: 'Loop Detected',
      510: 'Not Extended',
      511: 'Network Authentication Required'
    };
    return messages[statusCode] || `Error ${statusCode}`;
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