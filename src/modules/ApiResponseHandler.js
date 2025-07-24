class ApiResponseHandler {
  constructor(logger, templateEngine) {
    this.logger = logger.child({ module: 'ApiResponseHandler' });
    this.templateEngine = templateEngine;
  }

  /**
   * Send response based on configuration
   * @param {Object} reply - Fastify reply object
   * @param {Object} responseConfig - Response configuration
   * @param {Object} context - Template context
   */
  async sendResponse(reply, responseConfig, context = {}) {
    try {
      // Apply delay if configured
      if (responseConfig.delay && responseConfig.delay > 0) {
        await new Promise(resolve => setTimeout(resolve, responseConfig.delay));
      }

      // Set status code
      reply.code(responseConfig.status || 200);

      // Set headers
      if (responseConfig.headers) {
        for (const [name, value] of Object.entries(responseConfig.headers)) {
          reply.header(name, value);
        }
      }

      // Send body
      if (responseConfig.jsonBody !== undefined) {
        // Process templates in JSON body
        const processedBody = this.processTemplatesInObject(responseConfig.jsonBody, context);
        reply.type('application/json').send(processedBody);
      } else if (responseConfig.body !== undefined) {
        // Process templates in string body
        const processedBody = this.templateEngine.process(responseConfig.body, context);
        reply.send(processedBody);
      } else if (responseConfig.base64Body !== undefined) {
        // Decode base64 and send
        const buffer = Buffer.from(responseConfig.base64Body, 'base64');
        reply.send(buffer);
      } else {
        // No body
        reply.send();
      }

      this.logger.debug({
        status: responseConfig.status || 200,
        headers: responseConfig.headers,
        hasBody: !!(responseConfig.jsonBody || responseConfig.body || responseConfig.base64Body),
        delay: responseConfig.delay
      }, 'API response sent');

    } catch (error) {
      this.logger.error({
        error: error.message,
        responseConfig
      }, 'Error sending API response');
      
      reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Failed to send mock response'
      });
    }
  }

  /**
   * Process template variables in an object recursively
   * @param {*} obj - Object to process
   * @param {Object} context - Template context
   * @returns {*} Processed object
   */
  processTemplatesInObject(obj, context) {
    if (typeof obj === 'string') {
      return this.templateEngine.process(obj, context);
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.processTemplatesInObject(item, context));
    }
    
    if (obj && typeof obj === 'object') {
      const processed = {};
      for (const [key, value] of Object.entries(obj)) {
        processed[key] = this.processTemplatesInObject(value, context);
      }
      return processed;
    }
    
    return obj;
  }
}

module.exports = ApiResponseHandler;