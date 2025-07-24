const { EventEmitter } = require('events');

class SchedulerService extends EventEmitter {
  constructor(logger, templateEngine) {
    super();
    this.logger = logger;
    this.templateEngine = templateEngine;
    this.scheduledTasks = new Map();
    this.taskExecutionCount = new Map();
    this.taskExecutionHistory = new Map();
  }

  /**
   * Start scheduled messages for a configuration
   * @param {Object} config - Configuration containing scheduled messages
   * @param {Function} broadcastFn - Function to broadcast messages
   */
  startScheduledMessages(config, broadcastFn) {
    if (!config.scheduledMessages || config.scheduledMessages.length === 0) {
      this.logger.debug({ configName: config.name }, 'No scheduled messages to start');
      return;
    }

    config.scheduledMessages.forEach(scheduledMsg => {
      if (!scheduledMsg.enabled) {
        this.logger.debug({
          configName: config.name,
          messageId: scheduledMsg.id
        }, 'Scheduled message disabled, skipping');
        return;
      }

      this.scheduleMessage(config.name, scheduledMsg, broadcastFn);
    });

    // Started scheduled messages
  }

  /**
   * Schedule a single message
   * @param {string} configName - Configuration name
   * @param {Object} scheduledMsg - Scheduled message configuration
   * @param {Function} broadcastFn - Broadcast function
   */
  scheduleMessage(configName, scheduledMsg, broadcastFn) {
    const taskKey = `${configName}:${scheduledMsg.id}`;
    
    // Clear existing task if any
    this.stopTask(taskKey);

    const startDelay = scheduledMsg.startDelay || 0;
    const interval = scheduledMsg.interval;

    // Validate interval
    if (interval < 100) {
      this.logger.warn({
        configName,
        messageId: scheduledMsg.id,
        interval
      }, 'Interval too short, minimum is 100ms');
      return;
    }

    // Schedule the task
    const startTime = Date.now();
    
    setTimeout(() => {
      // Execute immediately on start if configured
      if (scheduledMsg.sendOnStart) {
        this.executeScheduledMessage(configName, scheduledMsg, broadcastFn);
      }

      // Set up recurring interval
      const intervalId = setInterval(() => {
        this.executeScheduledMessage(configName, scheduledMsg, broadcastFn);
      }, interval);

      // Store task information
      this.scheduledTasks.set(taskKey, {
        intervalId,
        configName,
        scheduledMsg,
        startedAt: new Date(),
        interval,
        startDelay,
        nextExecution: new Date(Date.now() + interval)
      });

      this.logger.debug({
        taskKey,
        interval
      }, 'Scheduled message task started');

      this.emit('task:started', {
        taskKey,
        configName,
        messageId: scheduledMsg.id
      });
    }, startDelay);
  }

  /**
   * Execute a scheduled message
   * @param {string} configName - Configuration name
   * @param {Object} scheduledMsg - Scheduled message
   * @param {Function} broadcastFn - Broadcast function
   */
  executeScheduledMessage(configName, scheduledMsg, broadcastFn) {
    const taskKey = `${configName}:${scheduledMsg.id}`;
    const executionId = `${taskKey}:${Date.now()}`;
    const startTime = Date.now();

    try {
      // Process template
      const context = {
        scheduled: {
          configName,
          messageId: scheduledMsg.id,
          executionTime: new Date().toISOString(),
          executionCount: this.getExecutionCount(taskKey) + 1
        }
      };

      const message = this.templateEngine.process(scheduledMsg.message, context);

      // Broadcast the message
      const result = broadcastFn(configName, message, {
        source: 'scheduled',
        messageId: scheduledMsg.id
      });

      const executionTime = Date.now() - startTime;

      // Update execution count
      this.incrementExecutionCount(taskKey);

      // Store execution history
      this.addToHistory(taskKey, {
        executionId,
        timestamp: new Date(),
        result,
        executionTime,
        message: scheduledMsg.logFullMessage ? message : { id: scheduledMsg.id }
      });

      // Update next execution time
      const task = this.scheduledTasks.get(taskKey);
      if (task) {
        task.nextExecution = new Date(Date.now() + task.interval);
      }

      this.logger.debug({
        taskKey,
        executionId,
        attempted: result.attempted,
        successful: result.successful,
        executionTime
      }, 'Scheduled message executed');

      this.emit('message:executed', {
        taskKey,
        executionId,
        result,
        executionTime
      });
    } catch (error) {
      this.logger.error({
        taskKey,
        error: error.message
      }, 'Error executing scheduled message');

      this.emit('message:error', {
        taskKey,
        error
      });

      // Store error in history
      this.addToHistory(taskKey, {
        executionId,
        timestamp: new Date(),
        error: error.message,
        executionTime: Date.now() - startTime
      });
    }
  }

  /**
   * Stop all scheduled messages for a configuration
   * @param {string} configName - Configuration name
   */
  stopScheduledMessages(configName) {
    let stoppedCount = 0;

    for (const [taskKey, task] of this.scheduledTasks) {
      if (task.configName === configName) {
        this.stopTask(taskKey);
        stoppedCount++;
      }
    }

    if (stoppedCount > 0) {
      this.logger.info({
        configName,
        stoppedCount
      }, 'Stopped scheduled messages');
    }
  }

  /**
   * Stop a specific task
   * @param {string} taskKey - Task key to stop
   */
  stopTask(taskKey) {
    const task = this.scheduledTasks.get(taskKey);
    
    if (task) {
      clearInterval(task.intervalId);
      this.scheduledTasks.delete(taskKey);
      
      this.logger.debug({ taskKey }, 'Stopped scheduled task');
      
      this.emit('task:stopped', {
        taskKey,
        configName: task.configName,
        messageId: task.scheduledMsg.id,
        executionCount: this.getExecutionCount(taskKey)
      });
    }
  }

  /**
   * Stop all scheduled tasks
   */
  stopAll() {
    const taskCount = this.scheduledTasks.size;
    
    for (const [taskKey, task] of this.scheduledTasks) {
      clearInterval(task.intervalId);
    }
    
    this.scheduledTasks.clear();
    
    this.logger.info({ taskCount }, 'Stopped all scheduled tasks');
    this.emit('all:stopped');
  }

  /**
   * Get status of all scheduled tasks
   * @param {string} configName - Optional config name filter
   * @returns {Array} Task status array
   */
  getStatus(configName = null) {
    const status = [];

    for (const [taskKey, task] of this.scheduledTasks) {
      if (configName && task.configName !== configName) continue;

      status.push({
        taskKey,
        configName: task.configName,
        messageId: task.scheduledMsg.id,
        interval: task.interval,
        startedAt: task.startedAt,
        nextExecution: task.nextExecution,
        executionCount: this.getExecutionCount(taskKey),
        enabled: task.scheduledMsg.enabled,
        description: task.scheduledMsg.description || 'No description'
      });
    }

    return status;
  }

  /**
   * Get execution statistics
   * @param {string} taskKey - Optional task key filter
   * @returns {Object} Execution statistics
   */
  getStatistics(taskKey = null) {
    if (taskKey) {
      return {
        taskKey,
        executionCount: this.getExecutionCount(taskKey),
        history: this.getHistory(taskKey),
        isActive: this.scheduledTasks.has(taskKey)
      };
    }

    // Global statistics
    const stats = {
      activeTasks: this.scheduledTasks.size,
      totalExecutions: 0,
      taskStats: {}
    };

    for (const [key, count] of this.taskExecutionCount) {
      stats.totalExecutions += count;
      stats.taskStats[key] = {
        executionCount: count,
        isActive: this.scheduledTasks.has(key)
      };
    }

    return stats;
  }

  /**
   * Pause a scheduled task
   * @param {string} taskKey - Task key to pause
   */
  pauseTask(taskKey) {
    const task = this.scheduledTasks.get(taskKey);
    
    if (task && !task.paused) {
      clearInterval(task.intervalId);
      task.paused = true;
      task.pausedAt = new Date();
      
      this.logger.info({ taskKey }, 'Paused scheduled task');
      
      this.emit('task:paused', {
        taskKey,
        configName: task.configName,
        messageId: task.scheduledMsg.id
      });
    }
  }

  /**
   * Resume a paused task
   * @param {string} taskKey - Task key to resume
   * @param {Function} broadcastFn - Broadcast function
   */
  resumeTask(taskKey, broadcastFn) {
    const task = this.scheduledTasks.get(taskKey);
    
    if (task && task.paused) {
      const intervalId = setInterval(() => {
        this.executeScheduledMessage(task.configName, task.scheduledMsg, broadcastFn);
      }, task.interval);
      
      task.intervalId = intervalId;
      task.paused = false;
      task.resumedAt = new Date();
      delete task.pausedAt;
      
      this.logger.info({ taskKey }, 'Resumed scheduled task');
      
      this.emit('task:resumed', {
        taskKey,
        configName: task.configName,
        messageId: task.scheduledMsg.id
      });
    }
  }

  /**
   * Update task configuration
   * @param {string} taskKey - Task key
   * @param {Object} updates - Updates to apply
   * @param {Function} broadcastFn - Broadcast function
   */
  updateTask(taskKey, updates, broadcastFn) {
    const task = this.scheduledTasks.get(taskKey);
    
    if (!task) {
      this.logger.warn({ taskKey }, 'Task not found for update');
      return false;
    }

    // Stop the current task
    this.stopTask(taskKey);

    // Apply updates
    const updatedScheduledMsg = {
      ...task.scheduledMsg,
      ...updates
    };

    // Restart with new configuration
    this.scheduleMessage(task.configName, updatedScheduledMsg, broadcastFn);
    
    this.logger.info({
      taskKey,
      updates: Object.keys(updates)
    }, 'Updated scheduled task');
    
    return true;
  }

  /**
   * Get execution count for a task
   * @param {string} taskKey - Task key
   * @returns {number} Execution count
   */
  getExecutionCount(taskKey) {
    return this.taskExecutionCount.get(taskKey) || 0;
  }

  /**
   * Increment execution count
   * @param {string} taskKey - Task key
   */
  incrementExecutionCount(taskKey) {
    const current = this.getExecutionCount(taskKey);
    this.taskExecutionCount.set(taskKey, current + 1);
  }

  /**
   * Add to execution history
   * @param {string} taskKey - Task key
   * @param {Object} entry - History entry
   */
  addToHistory(taskKey, entry) {
    if (!this.taskExecutionHistory.has(taskKey)) {
      this.taskExecutionHistory.set(taskKey, []);
    }

    const history = this.taskExecutionHistory.get(taskKey);
    history.push(entry);

    // Keep only last 100 executions
    if (history.length > 100) {
      history.shift();
    }
  }

  /**
   * Get execution history
   * @param {string} taskKey - Task key
   * @param {number} limit - Number of entries to return
   * @returns {Array} History entries
   */
  getHistory(taskKey, limit = 10) {
    const history = this.taskExecutionHistory.get(taskKey) || [];
    return history.slice(-limit);
  }

  /**
   * Clear all history and counts
   */
  clearHistory() {
    this.taskExecutionCount.clear();
    this.taskExecutionHistory.clear();
    
    this.logger.info('Cleared all scheduler history');
  }
}

module.exports = SchedulerService;