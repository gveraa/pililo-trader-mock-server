const { EventEmitter } = require('events');

class ConnectionManager extends EventEmitter {
  constructor(logger) {
    super();
    this.logger = logger;
    this.connections = new Map();
    this.connectionsByConfig = new Map();
    this.connectionStats = new Map();
  }

  /**
   * Register a new WebSocket connection
   * @param {Object} connection - WebSocket connection object
   * @param {Object} config - Configuration for this connection
   * @param {Object} metadata - Additional connection metadata
   * @returns {string} Connection ID
   */
  addConnection(connection, config, metadata = {}) {
    const connectionId = this.generateConnectionId(config.name);
    
    const connectionInfo = {
      id: connectionId,
      socket: connection.socket,
      config: config,
      connectedAt: new Date(),
      lastActivity: new Date(),
      metadata: {
        ...metadata,
        remoteAddress: connection.socket._socket?.remoteAddress || 'unknown',
        userAgent: metadata.headers?.['user-agent'] || 'unknown'
      },
      messageCount: {
        sent: 0,
        received: 0
      }
    };

    // Store connection
    this.connections.set(connectionId, connectionInfo);

    // Track connections by config
    if (!this.connectionsByConfig.has(config.name)) {
      this.connectionsByConfig.set(config.name, new Set());
    }
    this.connectionsByConfig.get(config.name).add(connectionId);

    // Update stats
    this.updateConnectionStats(config.name, 'connect');

    // Check connection limits
    const maxConnections = config.connectionBehavior?.maxConnections || 100;
    const currentConnections = this.connectionsByConfig.get(config.name).size;
    
    if (currentConnections > maxConnections) {
      this.logger.warn({
        configName: config.name,
        currentConnections,
        maxConnections
      }, 'Connection limit exceeded');
      
      // Optionally close the connection
      connection.socket.close(1008, 'Connection limit exceeded');
      this.removeConnection(connectionId);
      return null;
    }

    this.logger.info({
      connectionId,
      configName: config.name,
      remoteAddress: connectionInfo.metadata.remoteAddress,
      totalConnections: currentConnections
    }, 'Connection registered');

    this.emit('connection:added', connectionInfo);
    return connectionId;
  }

  /**
   * Remove a connection
   * @param {string} connectionId - Connection ID to remove
   */
  removeConnection(connectionId) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    // Remove from main store
    this.connections.delete(connectionId);

    // Remove from config tracking
    const configConnections = this.connectionsByConfig.get(connection.config.name);
    if (configConnections) {
      configConnections.delete(connectionId);
      if (configConnections.size === 0) {
        this.connectionsByConfig.delete(connection.config.name);
      }
    }

    // Update stats
    this.updateConnectionStats(connection.config.name, 'disconnect');

    // Calculate connection duration
    const duration = Date.now() - connection.connectedAt.getTime();
    
    this.logger.info({
      connectionId,
      configName: connection.config.name,
      duration,
      messagesSent: connection.messageCount.sent,
      messagesReceived: connection.messageCount.received
    }, 'Connection removed');

    this.emit('connection:removed', connection);
  }

  /**
   * Get connection by ID
   * @param {string} connectionId - Connection ID
   * @returns {Object|null} Connection info or null
   */
  getConnection(connectionId) {
    return this.connections.get(connectionId) || null;
  }

  /**
   * Get all connections for a specific configuration
   * @param {string} configName - Configuration name
   * @returns {Array} Array of connections
   */
  getConnectionsByConfig(configName) {
    const connectionIds = this.connectionsByConfig.get(configName);
    if (!connectionIds) return [];

    return Array.from(connectionIds)
      .map(id => this.connections.get(id))
      .filter(Boolean);
  }

  /**
   * Broadcast message to all connections of a specific config
   * @param {string} configName - Configuration name
   * @param {any} message - Message to send
   * @param {Object} options - Broadcast options
   * @returns {Object} Broadcast result
   */
  broadcast(configName, message, options = {}) {
    const connections = this.getConnectionsByConfig(configName);
    const results = {
      attempted: connections.length,
      successful: 0,
      failed: 0,
      errors: []
    };

    const messageStr = typeof message === 'string' ? message : JSON.stringify(message);

    connections.forEach(conn => {
      try {
        if (conn.socket.readyState === 1) { // WebSocket.OPEN
          conn.socket.send(messageStr);
          conn.messageCount.sent++;
          conn.lastActivity = new Date();
          results.successful++;
        } else {
          results.failed++;
          results.errors.push({
            connectionId: conn.id,
            reason: 'Connection not open',
            readyState: conn.socket.readyState
          });
        }
      } catch (error) {
        results.failed++;
        results.errors.push({
          connectionId: conn.id,
          reason: error.message
        });
        
        this.logger.error({
          connectionId: conn.id,
          error: error.message
        }, 'Failed to broadcast message');
      }
    });

    this.logger.debug({
      configName,
      ...results
    }, 'Broadcast completed');

    return results;
  }

  /**
   * Send message to specific connection
   * @param {string} connectionId - Connection ID
   * @param {any} message - Message to send
   * @returns {boolean} Success status
   */
  sendToConnection(connectionId, message) {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      this.logger.warn({ connectionId }, 'Connection not found');
      return false;
    }

    try {
      const messageStr = typeof message === 'string' ? message : JSON.stringify(message);
      connection.socket.send(messageStr);
      connection.messageCount.sent++;
      connection.lastActivity = new Date();
      
      this.emit('message:sent', {
        connectionId,
        message: messageStr
      });
      
      return true;
    } catch (error) {
      this.logger.error({
        connectionId,
        error: error.message
      }, 'Failed to send message');
      return false;
    }
  }

  /**
   * Update message received count
   * @param {string} connectionId - Connection ID
   */
  recordMessageReceived(connectionId) {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.messageCount.received++;
      connection.lastActivity = new Date();
    }
  }

  /**
   * Get connection statistics
   * @param {string} configName - Optional config name for filtered stats
   * @returns {Object} Connection statistics
   */
  getStats(configName = null) {
    if (configName) {
      return {
        configName,
        currentConnections: this.connectionsByConfig.get(configName)?.size || 0,
        stats: this.connectionStats.get(configName) || {
          totalConnections: 0,
          totalDisconnections: 0,
          peakConnections: 0
        }
      };
    }

    // Global stats
    const stats = {
      totalActiveConnections: this.connections.size,
      byConfig: {}
    };

    for (const [name, connectionIds] of this.connectionsByConfig) {
      stats.byConfig[name] = {
        activeConnections: connectionIds.size,
        stats: this.connectionStats.get(name) || {
          totalConnections: 0,
          totalDisconnections: 0,
          peakConnections: 0
        }
      };
    }

    return stats;
  }

  /**
   * Clean up stale connections
   * @param {number} maxIdleTime - Maximum idle time in milliseconds
   * @returns {number} Number of connections closed
   */
  cleanupStaleConnections(maxIdleTime = 300000) { // 5 minutes default
    let closedCount = 0;
    const now = Date.now();

    for (const [connectionId, connection] of this.connections) {
      const idleTime = now - connection.lastActivity.getTime();
      
      if (idleTime > maxIdleTime) {
        this.logger.info({
          connectionId,
          idleTime,
          maxIdleTime
        }, 'Closing stale connection');
        
        try {
          connection.socket.close(1000, 'Idle timeout');
        } catch (error) {
          this.logger.error({
            connectionId,
            error: error.message
          }, 'Error closing stale connection');
        }
        
        this.removeConnection(connectionId);
        closedCount++;
      }
    }

    if (closedCount > 0) {
      this.logger.info({ closedCount }, 'Cleaned up stale connections');
    }

    return closedCount;
  }

  /**
   * Generate unique connection ID
   * @param {string} configName - Configuration name
   * @returns {string} Connection ID
   */
  generateConnectionId(configName) {
    return `${configName}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Update connection statistics
   * @param {string} configName - Configuration name
   * @param {string} event - Event type (connect/disconnect)
   */
  updateConnectionStats(configName, event) {
    if (!this.connectionStats.has(configName)) {
      this.connectionStats.set(configName, {
        totalConnections: 0,
        totalDisconnections: 0,
        peakConnections: 0
      });
    }

    const stats = this.connectionStats.get(configName);
    const currentConnections = this.connectionsByConfig.get(configName)?.size || 0;

    if (event === 'connect') {
      stats.totalConnections++;
      stats.peakConnections = Math.max(stats.peakConnections, currentConnections);
    } else if (event === 'disconnect') {
      stats.totalDisconnections++;
    }
  }

  /**
   * Close all connections
   * @param {string} configName - Optional config name to close specific connections
   * @param {string} reason - Close reason
   */
  closeAllConnections(configName = null, reason = 'Server shutdown') {
    const connections = configName 
      ? this.getConnectionsByConfig(configName)
      : Array.from(this.connections.values());

    connections.forEach(conn => {
      try {
        conn.socket.close(1001, reason);
      } catch (error) {
        this.logger.error({
          connectionId: conn.id,
          error: error.message
        }, 'Error closing connection');
      }
    });

    this.logger.info({
      count: connections.length,
      configName: configName || 'all'
    }, 'Closed connections');
  }
}

module.exports = ConnectionManager;