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
const RequestLogger = require('./modules/RequestLogger');
const MockMatcherDebugger = require('./modules/MockMatcherDebugger');
const ScenarioValidator = require('./modules/ScenarioValidator');
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
    
    // Initialize diagnostic tools
    this.requestLogger = new RequestLogger(logger);
    this.matcherDebugger = new MockMatcherDebugger(logger);
    this.scenarioValidator = new ScenarioValidator(logger);
    
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
      await this.configManager.loadSchema();
      this.logger.info('Schemas loaded successfully');
      
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
          this.logger.warn('No configuration files found in the mocks directory');
        } else {
          this.logger.error(`All ${loadResults.summary.total} configuration files failed validation`);
        }
        // Don't throw error, just log and continue with empty configurations
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
        const endpointsInfo = {
          endpoints: [],
          mappingsWithScenarios: []
        };
        
        if (config.mappings) {
          config.mappings.forEach((mapping, index) => {
            const method = mapping.request.method || 'ANY';
            const path = mapping.request.urlPath || mapping.request.urlPathPattern || '/*';
            const isPattern = !!mapping.request.urlPathPattern;
            
            // Build endpoint object with all matching conditions
            const endpointObj = {
              id: mapping.id || `mapping-${index}`,
              method: method,
              path: path,
              pathType: isPattern ? 'pattern' : 'exact',
              priority: mapping._priority || this.calculateMappingPriority(mapping)
            };
            
            // Add required headers
            if (mapping.request.headers) {
              endpointObj.headers = {};
              Object.entries(mapping.request.headers).forEach(([name, criteria]) => {
                if (typeof criteria === 'string') {
                  endpointObj.headers[name] = { equals: criteria };
                } else {
                  endpointObj.headers[name] = criteria;
                }
              });
            }
            
            // Add query parameters
            if (mapping.request.queryParameters) {
              endpointObj.queryParameters = mapping.request.queryParameters;
            }
            
            // Add body patterns
            if (mapping.request.bodyPatterns) {
              endpointObj.bodyPatterns = mapping.request.bodyPatterns;
            }
            
            // Add response status
            endpointObj.responseStatus = mapping.response.status || 200;
            
            endpointsInfo.endpoints.push(endpointObj);
            
            // Track scenario restrictions if any
            if (mapping.allowedScenarios || mapping.forbiddenScenarios) {
              endpointsInfo.mappingsWithScenarios.push({
                endpoint: endpointObj,
                allowedScenarios: mapping.allowedScenarios,
                forbiddenScenarios: mapping.forbiddenScenarios
              });
            }
          });
        }
        
        const key = config._location || config.name;
        this.loadedMocks.api[key] = endpointsInfo;
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
    
    // Create a single Fastify server regardless of configurations
    const server = await this.createServer();
    
    if (configs.length === 0) {
      this.logger.warn('No configurations found to start - running with status endpoints only');
      
      // Add built-in endpoints so status and health checks work
      this.registerBuiltInEndpoints(server);
      
      // Start the server with just status endpoints
      const port = parseInt(process.env.PORT) || 8080;
      const host = process.env.HOST || '0.0.0.0';
      
      await server.listen({ port, host });
      this.logger.info(`Server running on ${host}:${port} (status endpoints only)`);
      this.activeServers.set('default', server);
      return;
    }
    
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
      // Logging is already handled by RequestLogger and MockMatcherDebugger
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

    // Register static file serving plugin (following Fastify best practices)
    await server.register(require('@fastify/static'), {
      root: require('path').join(process.cwd(), 'public'),
      prefix: '/public/',
      decorateReply: false // Don't add sendFile method to avoid conflicts
    });
    
    // Register view engine plugin for template rendering
    await server.register(require('@fastify/view'), {
      engine: {
        ejs: require('ejs')
      },
      root: require('path').join(process.cwd(), 'templates'),
      viewExt: 'html',
      propertyName: 'view'
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
      fastify.get('/ws', { websocket: true }, (socket, req) => {
        this.handleNewConnection(socket, req, config);
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
    const startTime = Date.now();
    
    // Generate correlation ID
    const correlationId = generateCorrelationId();
    request.correlationId = correlationId;
    
    // Validate scenario header if present
    const scenarioHeader = request.headers['x-mock-scenario'];
    let scenarioValidation = null;
    let parsedScenario = null;
    
    if (scenarioHeader) {
      scenarioValidation = this.scenarioValidator.validateScenarioHeader(scenarioHeader, correlationId);
      if (scenarioValidation.valid) {
        parsedScenario = parseScenarioHeader(scenarioHeader);
      }
    }
    
    // Log incoming request with diagnostic information
    this.requestLogger.logIncomingRequest(request, correlationId, parsedScenario);
    
    // Debug matching session (tests all mappings)
    const matchingSession = this.matcherDebugger.debugMatchingSession(
      correlationId, request, this.apiMappings, urlPath
    );
    
    // Try each mapping in priority order
    for (const mapping of this.apiMappings) {
      // Use fast matcher for optimized mappings
      const matches = mapping._optimized 
        ? this.fastApiMatcher.matches(request, mapping, urlPath)
        : await this.apiRequestMatcher.matches(request, mapping.request);
      
      if (matches) {
        // Log successful match with detailed information
        const matchDetails = mapping._optimized 
          ? this.fastApiMatcher.getMatchDetails(request, mapping)
          : {
              method: request.method,
              path: request.url,
              matchedPath: mapping.request.urlPath || mapping.request.urlPathPattern,
              priority: this.calculateMappingPriority(mapping),
              mappingId: mapping.id || mapping._mappingIndex,
              configName: mapping._configName
            };
        
        this.requestLogger.logMockMatch(correlationId, mapping, matchDetails);
        
        // Check for dynamic scenario patterns in header
        let responseConfig = { ...mapping.response };
        
        // Check if scenarios are allowed for this mapping
        if (scenarioHeader && scenarioValidation?.valid && this.isScenarioAllowed(scenarioHeader, mapping)) {
          if (parsedScenario) {
            // Handle multiple scenarios
            const scenarios = parsedScenario.type === 'multiple' ? parsedScenario.scenarios : [parsedScenario];
            
            for (const scenario of scenarios) {
              const modifications = await this.applyScenario(scenario, responseConfig, request, reply);
              if (modifications) {
                this.requestLogger.logScenarioApplication(correlationId, scenario, modifications);
              }
            }
          }
        } else if (scenarioHeader && !scenarioValidation?.valid) {
          // Log scenario validation failure
          this.logger.warn({
            correlationId,
            scenarioHeader,
            validation: scenarioValidation
          }, `Invalid scenario header ignored: ${scenarioHeader}`);
        }
        
        // Process response
        const processingTime = Date.now() - startTime;
        await this.apiResponseHandler.sendResponse(reply, responseConfig, { request, correlationId });
        
        // Log response details
        this.requestLogger.logResponse(correlationId, responseConfig, processingTime);
        
        return true;
      }
    }
    
    // No match found - check if we have partial matches
    const processingTime = Date.now() - startTime;
    
    // Check if we had partial matches from the debug session
    if (matchingSession && matchingSession.finalResult && matchingSession.finalResult.pathMatches > 0) {
      // We have partial matches - return 400 with details
      const partialMatches = matchingSession.finalResult.partialMatches;
      const errorResponse = {
        error: 'Bad Request',
        message: 'Request matched a path but failed validation',
        method: request.method,
        path: request.url,
        failures: partialMatches.map(pm => ({
          endpoint: {
            id: pm.endpoint.id,
            method: pm.endpoint.method,
            path: pm.endpoint.path
          },
          failedOn: pm.failedOn.check,
          reason: pm.failedOn.reason,
          requirements: this.getRequirementsForEndpoint(pm.endpoint)
        }))
      };
      
      reply.code(400).send(errorResponse);
      return true; // We handled the response
    }
    
    // No partial matches - truly no match found
    // Logging is already handled by RequestLogger and MockMatcherDebugger
    return false;
  }

  /**
   * Get requirements for an endpoint to show in error messages
   */
  getRequirementsForEndpoint(endpoint) {
    const requirements = {};
    
    if (endpoint.headers) {
      requirements.headers = endpoint.headers;
    }
    
    if (endpoint.queryParameters) {
      requirements.queryParameters = endpoint.queryParameters;
    }
    
    if (endpoint.bodyPatterns) {
      requirements.bodyPatterns = endpoint.bodyPatterns;
    }
    
    return requirements;
  }

  /**
   * Check if a scenario is allowed for a specific mapping
   */
  isScenarioAllowed(scenarioHeader, mapping) {
    // If no restrictions are defined, all scenarios are allowed
    if (!mapping.allowedScenarios && !mapping.forbiddenScenarios) {
      return true;
    }
    
    // Split scenarios if multiple
    const scenarios = scenarioHeader.split(',').map(s => s.trim());
    
    // Check allowed list (whitelist)
    if (mapping.allowedScenarios) {
      return scenarios.every(scenario => 
        mapping.allowedScenarios.some(allowed => 
          this.matchesScenarioPattern(scenario, allowed)
        )
      );
    }
    
    // Check forbidden list (blacklist)
    if (mapping.forbiddenScenarios) {
      return scenarios.every(scenario => 
        !mapping.forbiddenScenarios.some(forbidden => 
          this.matchesScenarioPattern(scenario, forbidden)
        )
      );
    }
    
    return true;
  }
  
  /**
   * Check if a scenario matches a pattern
   */
  matchesScenarioPattern(scenario, pattern) {
    // Exact match
    if (scenario === pattern) return true;
    
    // Pattern matching (convert pattern to regex)
    // Replace [ms], [percent], [field-name], etc. with regex
    const regexPattern = pattern
      .replace(/\[ms\]/g, '\\d+')
      .replace(/\[percent\]/g, '\\d+')
      .replace(/\[field-name\]/g, '[\\w-]+')
      .replace(/\[header-name\]/g, '[\\w-]+')
      .replace(/\[seconds\]/g, '\\d+')
      .replace(/\[code\]/g, '\\d{3}');
      
    try {
      const regex = new RegExp(`^${regexPattern}$`);
      return regex.test(scenario);
    } catch (e) {
      // If pattern is invalid, do exact match
      return scenario === pattern;
    }
  }

  /**
   * Apply a single scenario to the response configuration
   */
  async applyScenario(scenario, responseConfig, request, reply) {
    const modifications = {
      status: null,
      headers: {},
      body: null,
      delay: null
    };

    const originalStatus = responseConfig.status;
    const originalDelay = responseConfig.delay;
    const originalBody = responseConfig.jsonBody || responseConfig.body;

    switch (scenario.type) {
      case 'timeout':
      case 'slow':
        if (scenario.isRequestTimeout) {
          // Handle request timeout - delay then return 408
          responseConfig.delay = scenario.value;
          responseConfig.status = 408;
          responseConfig.jsonBody = {
            error: 'Request Timeout',
            message: 'The server did not receive a complete request within the timeout period',
            timestamp: "{{timestamp}}"
          };
          modifications.delay = scenario.value;
          modifications.status = 408;
          modifications.body = true;
        } else {
          // Just add delay
          responseConfig.delay = scenario.value;
          modifications.delay = scenario.value;
        }
        this.logger.debug({
          scenario: scenario,
          delayMs: responseConfig.delay
        }, `Dynamic ${scenario.type} applied`);
        break;
      
      case 'network-error':
        // Simulate network errors by closing connection abruptly
        reply.raw.destroy();
        this.logger.debug({
          scenario: scenario,
          error: scenario.value
        }, 'Simulating network error');
        return { ...modifications, networkError: scenario.value };
      
      case 'error':
        responseConfig.status = scenario.value;
        modifications.status = scenario.value;
        // Provide a default error body if none exists
        if (!responseConfig.jsonBody && !responseConfig.body) {
          responseConfig.jsonBody = {
            error: `HTTP ${scenario.value}`,
            message: this.getDefaultErrorMessage(scenario.value),
            timestamp: "{{timestamp}}"
          };
          modifications.body = true;
        }
        this.logger.debug({
          scenario: scenario,
          statusCode: scenario.value
        }, 'Dynamic error code applied');
        break;
      
      case 'auth':
        const authMods = await this.handleAuthScenario(scenario, responseConfig, request);
        Object.assign(modifications, authMods);
        break;
      
      case 'data':
        const dataMods = await this.handleDataScenario(scenario, responseConfig);
        Object.assign(modifications, dataMods);
        break;
    }

    // Clean up modifications - only include what actually changed
    const result = {};
    if (modifications.status && modifications.status !== originalStatus) {
      result.status = modifications.status;
    }
    if (modifications.delay && modifications.delay !== originalDelay) {
      result.delay = modifications.delay;
    }
    if (modifications.body || (responseConfig.jsonBody !== originalBody || responseConfig.body !== originalBody)) {
      result.body = true;
    }
    if (Object.keys(modifications.headers).length > 0) {
      result.headers = modifications.headers;
    }
    if (modifications.networkError) {
      result.networkError = modifications.networkError;
    }

    return Object.keys(result).length > 0 ? result : null;
  }

  /**
   * Handle authentication scenarios
   */
  async handleAuthScenario(scenario, responseConfig, request) {
    const { subtype, method, header, reason } = scenario;
    const modifications = { status: null, body: false };
    
    if (subtype === 'valid') {
      // For valid auth scenarios, just return success
      responseConfig.status = 200;
      modifications.status = 200;
      if (!responseConfig.jsonBody) {
        responseConfig.jsonBody = {
          authenticated: true,
          method: method,
          timestamp: "{{timestamp}}"
        };
        modifications.body = true;
      }
    } else if (subtype === 'invalid') {
      responseConfig.status = 401;
      modifications.status = 401;
      const messages = {
        bearer: reason === 'expired' ? 'Bearer token has expired' : 
                reason === 'malformed' ? 'Malformed bearer token' : 'Invalid bearer token',
        basic: reason === 'format' ? 'Malformed basic auth header' : 'Invalid credentials',
        apikey: `Invalid API key in ${header} header`,
        jwt: reason === 'expired' ? 'JWT token has expired' : 'Invalid JWT token',
        oauth2: 'Invalid OAuth2 access token'
      };
      responseConfig.jsonBody = {
        error: 'Unauthorized',
        message: messages[method] || 'Authentication failed',
        timestamp: "{{timestamp}}"
      };
      modifications.body = true;
    } else if (subtype === 'missing') {
      responseConfig.status = 401;
      modifications.status = 401;
      const messages = {
        bearer: 'Missing Authorization header with Bearer token',
        basic: 'Missing Basic authentication credentials',
        apikey: `Missing required ${header} header`,
        jwt: 'Missing JWT token',
        oauth2: 'Missing OAuth2 access token'
      };
      responseConfig.jsonBody = {
        error: 'Unauthorized',
        message: messages[method] || 'No authentication provided',
        timestamp: "{{timestamp}}"
      };
      modifications.body = true;
    }

    return modifications;
  }

  /**
   * Handle data response scenarios
   */
  async handleDataScenario(scenario, responseConfig) {
    const { subtype, percent, field } = scenario;
    const modifications = { body: false };
    
    switch (subtype) {
      case 'partial':
        // Return only a percentage of data
        if (responseConfig.jsonBody && Array.isArray(responseConfig.jsonBody)) {
          const totalItems = responseConfig.jsonBody.length;
          const itemsToReturn = Math.floor(totalItems * (percent / 100));
          responseConfig.jsonBody = responseConfig.jsonBody.slice(0, itemsToReturn);
          modifications.body = true;
        } else if (responseConfig.jsonBody && responseConfig.jsonBody.data && Array.isArray(responseConfig.jsonBody.data)) {
          const totalItems = responseConfig.jsonBody.data.length;
          const itemsToReturn = Math.floor(totalItems * (percent / 100));
          responseConfig.jsonBody.data = responseConfig.jsonBody.data.slice(0, itemsToReturn);
          modifications.body = true;
        }
        break;
      
      case 'missing-field':
        // Remove specified field from response
        if (responseConfig.jsonBody) {
          this.removeFieldFromObject(responseConfig.jsonBody, field);
          modifications.body = true;
        }
        break;
      
      case 'null-field':
        // Set specified field to null
        if (responseConfig.jsonBody) {
          this.setFieldInObject(responseConfig.jsonBody, field, null);
          modifications.body = true;
        }
        break;
      
      case 'wrong-type':
        // Change field to wrong type
        if (responseConfig.jsonBody) {
          const currentValue = this.getFieldFromObject(responseConfig.jsonBody, field);
          if (currentValue !== undefined) {
            // Convert to different type
            const wrongValue = typeof currentValue === 'number' ? String(currentValue) :
                             typeof currentValue === 'string' ? 123 :
                             typeof currentValue === 'boolean' ? 'true' :
                             Array.isArray(currentValue) ? {} : [];
            this.setFieldInObject(responseConfig.jsonBody, field, wrongValue);
            modifications.body = true;
          }
        }
        break;
      
      case 'corrupted':
        // Return corrupted JSON
        responseConfig.body = JSON.stringify(responseConfig.jsonBody || {}).slice(0, -5) + '{{corrupted';
        delete responseConfig.jsonBody;
        modifications.body = true;
        break;
      
      case 'extra-fields':
        // Add extra unexpected fields
        if (responseConfig.jsonBody) {
          responseConfig.jsonBody._unexpected_field_1 = "unexpected value";
          responseConfig.jsonBody._unexpected_field_2 = 12345;
          responseConfig.jsonBody._debug_info = { internal: true, version: "2.0" };
          modifications.body = true;
        }
        break;
      
      case 'truncated':
        // Truncate response at specified percentage
        const jsonString = JSON.stringify(responseConfig.jsonBody || {});
        const truncateAt = Math.floor(jsonString.length * (percent / 100));
        responseConfig.body = jsonString.slice(0, truncateAt);
        delete responseConfig.jsonBody;
        modifications.body = true;
        break;
    }

    return modifications;
  }

  /**
   * Helper to remove field from nested object
   */
  removeFieldFromObject(obj, fieldPath) {
    const parts = fieldPath.split('.');
    const lastPart = parts.pop();
    let current = obj;
    
    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = current[part];
      } else {
        return;
      }
    }
    
    if (current && typeof current === 'object') {
      delete current[lastPart];
    }
  }

  /**
   * Helper to set field in nested object
   */
  setFieldInObject(obj, fieldPath, value) {
    const parts = fieldPath.split('.');
    const lastPart = parts.pop();
    let current = obj;
    
    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = current[part];
      } else {
        return;
      }
    }
    
    if (current && typeof current === 'object') {
      current[lastPart] = value;
    }
  }

  /**
   * Helper to get field from nested object
   */
  getFieldFromObject(obj, fieldPath) {
    const parts = fieldPath.split('.');
    let current = obj;
    
    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = current[part];
      } else {
        return undefined;
      }
    }
    
    return current;
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
    // Root endpoint - Return README as HTML using Fastify view engine
    server.get('/', async (request, reply) => {
      const correlationId = generateCorrelationId();
      this.logger.info(createRequestLog(request.method, request.url, correlationId),
        `→ [${correlationId}] ${request.method} ${request.url}`);
      
      try {
        const templateData = await this.generateReadmeTemplateData(request);
        
        this.logger.info(createResponseLog(request.method, request.url, correlationId, 200),
          `← [${correlationId}] 200 ${request.method} ${request.url}`);
        return reply.view('readme.html', templateData);
      } catch (error) {
        this.logger.error({ error: error.message }, 'Failed to generate README HTML');
        this.logger.info(createResponseLog(request.method, request.url, correlationId, 500),
          `← [${correlationId}] 500 ${request.method} ${request.url}`);
        return reply.code(500).type('text/html').send(`
          <html>
            <head><title>Error</title></head>
            <body style="font-family: Arial, sans-serif; margin: 40px; color: #d32f2f;">
              <h1>Error Loading Documentation</h1>
              <p>Could not load README.md file: ${error.message}</p>
            </body>
          </html>
        `);
      }
    });
    
    // Raw file endpoint - Serve files referenced in markdown
    server.get('/raw/*', async (request, reply) => {
      const correlationId = generateCorrelationId();
      this.logger.info(createRequestLog(request.method, request.url, correlationId),
        `→ [${correlationId}] ${request.method} ${request.url}`);
      
      try {
        const fs = require('fs').promises;
        const path = require('path');
        
        // Extract file path from URL (remove /raw/ prefix)
        const filePath = request.params['*'];
        const fullPath = path.join(process.cwd(), filePath);
        
        // Security check: ensure the path is within the project directory
        const projectRoot = path.resolve(process.cwd());
        const resolvedPath = path.resolve(fullPath);
        
        if (!resolvedPath.startsWith(projectRoot)) {
          reply.code(403);
          this.logger.warn({ filePath, resolvedPath }, 'Attempted access outside project directory');
          return 'Access denied: Path outside project directory';
        }
        
        // Check if file exists
        try {
          const stats = await fs.stat(resolvedPath);
          if (!stats.isFile()) {
            reply.code(404);
            return 'Not found: Path is not a file';
          }
        } catch (error) {
          reply.code(404);
          return 'File not found';
        }
        
        // Read and serve the file
        const fileContent = await fs.readFile(resolvedPath, 'utf8');
        const ext = path.extname(resolvedPath).toLowerCase();
        
        // Set appropriate content type based on file extension
        switch (ext) {
          case '.json':
            reply.type('application/json');
            break;
          case '.md':
            reply.type('text/markdown');
            break;
          case '.js':
            reply.type('text/javascript');
            break;
          case '.yml':
          case '.yaml':
            reply.type('text/yaml');
            break;
          case '.txt':
            reply.type('text/plain');
            break;
          default:
            reply.type('text/plain');
        }
        
        this.logger.info(createResponseLog(request.method, request.url, correlationId, 200),
          `← [${correlationId}] 200 ${request.method} ${request.url}`);
        return fileContent;
        
      } catch (error) {
        this.logger.error({ error: error.message, filePath: request.params['*'] }, 'Failed to serve raw file');
        reply.code(500);
        this.logger.info(createResponseLog(request.method, request.url, correlationId, 500),
          `← [${correlationId}] 500 ${request.method} ${request.url}`);
        return 'Error: Could not load file';
      }
    });
    
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

    // Debug endpoint to check schema loading
    server.get('/debug/schemas', async (request, reply) => {
      return {
        configManagerExists: !!this.configManager,
        wsSchemaLoaded: !!this.configManager?.wsSchema,
        apiSchemaLoaded: !!this.configManager?.apiSchema,
        wsSchemaTitle: this.configManager?.wsSchema?.title || 'Not loaded',
        apiSchemaTitle: this.configManager?.apiSchema?.title || 'Not loaded',
        configManagerKeys: this.configManager ? Object.keys(this.configManager).filter(k => k.includes('schema') || k.includes('Schema')) : []
      };
    });

    // Status endpoint showing all loaded mocks
    server.get('/status', async (request, reply) => {
      const correlationId = generateCorrelationId();
      this.logger.info(createRequestLog(request.method, request.url, correlationId),
        `→ [${correlationId}] ${request.method} ${request.url}`);
      // Prepare API section with proper format
      const apiSection = {};
      Object.entries(this.loadedMocks.api).forEach(([key, value]) => {
        if (value.endpoints) {
          // New format with scenario info
          apiSection[key] = value.endpoints;
          if (value.mappingsWithScenarios && value.mappingsWithScenarios.length > 0) {
            apiSection[`${key}_scenarios`] = value.mappingsWithScenarios;
          }
        } else {
          // Old format (fallback)
          apiSection[key] = value;
        }
      });
      
      const status = {
        ws: this.loadedMocks.ws,
        api: apiSection
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
      // Debug logging
      this.logger.debug({
        hasConfigManager: !!this.configManager,
        hasWsSchema: !!this.configManager?.wsSchema,
        schemaKeys: this.configManager ? Object.keys(this.configManager) : []
      }, 'Schema endpoint accessed');
      
      if (!this.configManager.wsSchema) {
        return {
          error: 'WebSocket schema not loaded',
          message: 'Please ensure the schema files are properly loaded'
        };
      }
      
      // Return the WebSocket schema directly (it already contains all properties)
      return this.configManager.wsSchema;
    });

    server.get('/schema/api', async (request, reply) => {
      if (!this.configManager.apiSchema) {
        return {
          error: 'API schema not loaded',
          message: 'Please ensure the schema files are properly loaded'
        };
      }
      
      // Return the API schema directly (it already contains all properties)
      return this.configManager.apiSchema;
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

    // Reload configurations endpoint
    server.get('/reload', async (request, reply) => {
      const correlationId = generateCorrelationId();
      this.logger.info(createRequestLog(request.method, request.url, correlationId),
        `→ [${correlationId}] ${request.method} ${request.url}`);

      try {
        const result = await this.reloadAllConfigurations();

        this.logger.info(createResponseLog(request.method, request.url, correlationId, 200),
          `← [${correlationId}] 200 ${request.method} ${request.url}`);

        return {
          status: 'success',
          message: 'Configurations reloaded successfully',
          summary: result.summary,
          configurations: {
            ws: Object.keys(this.loadedMocks.ws),
            api: Object.keys(this.loadedMocks.api)
          }
        };
      } catch (error) {
        this.logger.error({ error: error.message }, 'Failed to reload configurations');

        this.logger.info(createResponseLog(request.method, request.url, correlationId, 500),
          `← [${correlationId}] 500 ${request.method} ${request.url}`);

        return reply.code(500).send({
          status: 'error',
          message: 'Failed to reload configurations',
          error: error.message
        });
      }
    });

  }

  /**
   * Handle new WebSocket connection
   * @param {Object} socket - WebSocket socket object from Fastify
   * @param {Object} req - HTTP request
   * @param {Object} config - Server configuration
   */
  handleNewConnection(socket, req, config) {
    // Register connection
    const connectionId = this.connectionManager.addConnection(socket, config, {
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
    socket.on('message', async (rawMessage) => {
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
    socket.on('close', () => {
      this.connectionManager.removeConnection(connectionId);
      this.messageHandler.clearHistory(connectionId);
    });

    // Handle errors
    socket.on('error', (error) => {
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

  /**
   * Reload all configurations from disk
   * @returns {Object} Reload results with summary
   */
  async reloadAllConfigurations() {
    this.logger.info('Starting configuration reload...');

    try {
      // Step 1: Stop all scheduled messages
      this.logger.info('Stopping all scheduled messages...');
      this.schedulerService.stopAll();

      // Step 2: Clear current configurations (but keep connections alive)
      this.logger.info('Clearing current configurations...');
      this.configManager.configs.clear();
      this.loadedMocks.ws = {};
      this.loadedMocks.api = {};
      this.failedMocks.ws = {};
      this.failedMocks.api = {};

      // Clear API mappings for re-registration
      this.apiMappings = [];
      this.registeredApiRoutes.clear();

      // Step 3: Reload configurations from disk (reuse same logic as initialize)
      this.logger.info('Reloading configurations from disk...');
      const loadResults = await this.configManager.loadConfigurations('mocks', {
        stopOnError: false,
        validateOnly: false
      });

      // Check if any configurations were loaded (same logic as initialize)
      if (loadResults.summary.loaded === 0) {
        if (loadResults.summary.total === 0) {
          this.logger.warn('No configuration files found in the mocks directory');
        } else {
          this.logger.error(`All ${loadResults.summary.total} configuration files failed validation`);
        }
      }

      // Step 4: Organize loaded mocks by type (same as initialize)
      this.organizeMocksByType(loadResults.configurations);

      // Organize failed mocks (same as initialize)
      if (loadResults.summary.errors && loadResults.summary.errors.length > 0) {
        this.organizeFailedMocks(loadResults.summary.errors);
      }

      // Step 5: Re-process API mappings using the same logic as registerApiHandlers
      const configs = this.configManager.getAllConfigurations();
      for (const config of configs) {
        if (config.type === 'api' && config.mappings) {
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

              // Store mapping with config info and priority (same as registerApiHandlers)
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
        }
      }

      // Sort API mappings by priority after all are registered (same as startAll)
      this.sortApiMappingsByPriority();

      // Step 6: Restart scheduled messages for WebSocket configs (same as startAll)
      this.logger.info('Restarting scheduled messages...');
      configs.filter(c => c.type === 'ws').forEach(config => {
        this.schedulerService.startScheduledMessages(config, (configName, message, options) => {
          return this.connectionManager.broadcast(configName, message, options);
        });
      });

      // Step 7: Update connection handlers with new configurations
      // Note: Existing WebSocket connections will use the new rules automatically
      // since they reference the config by name through connectionManager

      this.logger.info({
        loaded: loadResults.summary.loaded,
        failed: loadResults.summary.failed,
        wsConfigs: configs.filter(c => c.type === 'ws').length,
        apiConfigs: configs.filter(c => c.type === 'api').length,
        activeMappings: this.apiMappings.length
      }, 'Configuration reload completed');

      return loadResults;

    } catch (error) {
      this.logger.error({ error: error.message }, 'Failed to reload configurations');
      throw error;
    }
  }

  /**
   * Generate README template data for EJS rendering
   */
  async generateReadmeTemplateData(request) {
    const fs = require('fs').promises;
    const path = require('path');
    const { marked } = require('marked');

    // Read README.md
    const readmePath = path.join(process.cwd(), 'README.md');
    let readmeContent = await fs.readFile(readmePath, 'utf8');

    // Get host info for links
    const protocol = request.headers['x-forwarded-proto'] || (request.socket.encrypted ? 'https' : 'http');
    const host = request.headers.host || 'localhost:8080';
    const baseUrl = `${protocol}://${host}`;

    // Create compact version of original TOC structure
    const compactTOC = `## Table of Contents

- [Quick Start](#quick-start)
  - [Local Development](#local-development), [Docker Compose](#docker-compose), [Standalone Docker](#standalone-docker)
- [Features](#features)
- [How to create mocks?](#how-to-create-mocks)
  - [WebSocket](#websocket): [Schema](#websocket-schema), [Matchers](#matchers) (Exact, Contains, Regex, JSONPath)
  - [REST API](#rest-api): [Schema](#rest-api-schema), [Request Matching](#request-matching-rules), [Response Options](#response-options)
  - [X-Mock-Scenario Header](#x-mock-scenario-header): Performance, Auth, Data, Error scenarios
  - [Template Variables](#template-variables)
- [API Reference](#api-reference)
  - [Built-in Endpoints](#built-in-endpoints)
- [Development](#development)
  - [Mock Examples](#mock-examples), [Commands](#commands), [Environment Variables](#environment-variables), [Priority System](#priority-system), [Diagnostic Logging](#diagnostic-logging)`;

    const tocRegex = /## Table of Contents[\s\S]*?(?=##[^#])/;
    readmeContent = readmeContent.replace(tocRegex, compactTOC + '\n\n');
    
    readmeContent = this.transformMarkdownLinks(readmeContent, baseUrl);

    // Configure marked with custom renderer for header IDs
    const renderer = new marked.Renderer();
    renderer.heading = function(text, level, raw) {
      // Handle both string and object types from modern marked
      const textContent = typeof text === 'string' ? text : (text.raw || text.text || String(text));
      const headingLevel = level || 2; // Default to h2 if level is undefined
      const escapedText = textContent.toLowerCase()
        .replace(/[^\w\-\s]/g, '')  // Remove special characters
        .replace(/\s+/g, '-')       // Replace spaces with hyphens
        .replace(/^\-+|\-+$/g, ''); // Remove leading/trailing hyphens
      return `<h${headingLevel} id="${escapedText}">${textContent}</h${headingLevel}>`;
    };

    // Configure marked options
    marked.setOptions({
      breaks: true,
      gfm: true,
      renderer: renderer
    });

    // Convert to HTML
    const htmlContent = marked.parse(readmeContent);

    // Return template data for EJS rendering
    return {
      content: htmlContent,
      host: host
    };
  }

  /**
   * Transform markdown links for proper browser navigation
   */
  transformMarkdownLinks(content, baseUrl) {
    return content.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
      // Skip absolute URLs
      if (url.match(/^(https?|wss?):\/\//)) {
        return match;
      }

      // Skip internal anchors
      if (url.startsWith('#')) {
        return match;
      }

      // Check if this is a file link (has file extension)
      const isFile = /\.(json|md|js|yml|yaml|txt|css|html|xml|csv|log)$/i.test(url);
      
      // Check if this is a folder link (ends with / or is a known folder)
      const isFolder = url.endsWith('/') || 
                      url === './mocks' || 
                      url.match(/^\.\/[^.]*$/) ||  // ./folder-name without extension
                      url.match(/^[^.]*\/$/) ||    // folder-name/
                      (!isFile && !url.includes('.')); // No extension and no dot = likely folder

      // Skip folder links entirely - don't transform them
      if (isFolder) {
        return `[${text}](#)`;  // Convert to harmless anchor or remove entirely
      }

      // Convert file paths to /raw/ URLs only
      if (url.startsWith('./')) {
        const cleanUrl = url.substring(2);
        return `[${text}](${baseUrl}/raw/${cleanUrl})`;
      } else if (url.startsWith('/')) {
        return `[${text}](${baseUrl}/raw${url})`;
      }

      // Other relative file paths
      if (isFile) {
        return `[${text}](${baseUrl}/raw/${url})`;
      }

      // For anything else unclear, don't transform
      return match;
    });
  }
}

module.exports = MockServer;