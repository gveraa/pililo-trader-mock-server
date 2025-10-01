const { describe, it, expect, beforeEach, vi } = require('vitest');
const ConfigurationManager = require('../../src/modules/ConfigurationManager.js');
const fs = require('fs/promises');
const path = require('path');

// Mock the file system
vi.mock('fs/promises');
vi.mock('glob');

describe('ConfigurationManager', () => {
  let configManager;
  let mockLogger;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn()
    };

    configManager = new ConfigurationManager(mockLogger);
    vi.clearAllMocks();
  });

  describe('loadSchema', () => {
    it('should load WebSocket and API schemas successfully', async () => {
      const wsSchema = { title: 'WebSocket Schema', type: 'object' };
      const apiSchema = { title: 'API Schema', type: 'object' };

      fs.readFile
        .mockResolvedValueOnce(JSON.stringify(wsSchema))
        .mockResolvedValueOnce(JSON.stringify(apiSchema));

      await configManager.loadSchema();

      expect(configManager.wsSchema).toEqual(wsSchema);
      expect(configManager.apiSchema).toEqual(apiSchema);
      expect(configManager.wsValidate).toBeDefined();
      expect(configManager.apiValidate).toBeDefined();
    });

    it('should throw error when schema files are missing', async () => {
      fs.readFile.mockRejectedValue(new Error('File not found'));

      await expect(configManager.loadSchema()).rejects.toThrow('Failed to load schemas');
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should throw error when schema files contain invalid JSON', async () => {
      fs.readFile.mockResolvedValue('invalid json');

      await expect(configManager.loadSchema()).rejects.toThrow('Failed to load schemas');
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('validateConfiguration', () => {
    beforeEach(async () => {
      // Mock schemas
      const wsSchema = {
        type: 'object',
        required: ['name', 'type'],
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: ['ws'] }
        }
      };

      const apiSchema = {
        type: 'object',
        required: ['name', 'type'],
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: ['api'] }
        }
      };

      fs.readFile
        .mockResolvedValueOnce(JSON.stringify(wsSchema))
        .mockResolvedValueOnce(JSON.stringify(apiSchema));

      await configManager.loadSchema();
    });

    it('should validate valid WebSocket configuration', () => {
      const config = {
        name: 'test-ws',
        type: 'ws'
      };

      const result = configManager.validateConfiguration(config);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should validate valid API configuration', () => {
      const config = {
        name: 'test-api',
        type: 'api'
      };

      const result = configManager.validateConfiguration(config);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject configuration without type field', () => {
      const config = {
        name: 'test-config'
      };

      const result = configManager.validateConfiguration(config);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Missing required field: type');
    });

    it('should reject configuration with invalid type', () => {
      const config = {
        name: 'test-config',
        type: 'invalid'
      };

      const result = configManager.validateConfiguration(config);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain("Invalid type: invalid. Must be 'ws' or 'api'");
    });

    it('should reject configuration when schema not loaded', () => {
      configManager.wsValidate = null;
      configManager.apiValidate = null;

      const config = {
        name: 'test-config',
        type: 'ws'
      };

      const result = configManager.validateConfiguration(config);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Schema not loaded');
    });
  });

  describe('performSemanticValidation', () => {
    it('should detect duplicate response rule IDs', () => {
      const config = {
        type: 'ws',
        responseRules: [
          { id: 'rule1' },
          { id: 'rule2' },
          { id: 'rule1' } // Duplicate
        ]
      };

      const errors = configManager.performSemanticValidation(config);

      expect(errors).toContain('Duplicate response rule IDs found: rule1');
    });

    it('should detect duplicate scheduled message IDs', () => {
      const config = {
        type: 'ws',
        scheduledMessages: [
          { id: 'msg1' },
          { id: 'msg2' },
          { id: 'msg1' } // Duplicate
        ]
      };

      const errors = configManager.performSemanticValidation(config);

      expect(errors).toContain('Duplicate scheduled message IDs found: msg1');
    });

    it('should validate JSONPath expressions', () => {
      const config = {
        type: 'ws',
        responseRules: [
          {
            id: 'rule1',
            matcher: {
              type: 'jsonPath',
              path: 'invalid.path' // Should start with $
            }
          }
        ]
      };

      const errors = configManager.performSemanticValidation(config);

      expect(errors).toContain("Rule rule1: JSONPath must start with '$'");
    });

    it('should detect conflicting scenario restrictions', () => {
      const config = {
        type: 'api',
        mappings: [
          {
            id: 'mapping1',
            allowedScenarios: ['success'],
            forbiddenScenarios: ['error'] // Cannot have both
          }
        ]
      };

      const errors = configManager.performSemanticValidation(config);

      expect(errors).toContain('Mapping mapping1: Cannot define both allowedScenarios and forbiddenScenarios. Use only one.');
    });

    it('should detect duplicate mapping IDs', () => {
      const config = {
        type: 'api',
        mappings: [
          { id: 'map1' },
          { id: 'map2' },
          { id: 'map1' } // Duplicate
        ]
      };

      const errors = configManager.performSemanticValidation(config);

      expect(errors).toContain('Duplicate mapping IDs found: map1');
    });
  });

  describe('getConfiguration and getAllConfigurations', () => {
    it('should store and retrieve configurations', () => {
      const config = { name: 'test-config', type: 'ws' };

      configManager.configs.set('test-config', config);

      expect(configManager.getConfiguration('test-config')).toEqual(config);
      expect(configManager.getConfiguration('nonexistent')).toBeNull();
      expect(configManager.getAllConfigurations()).toContain(config);
    });
  });

  describe('reloadConfiguration', () => {
    it('should reload existing configuration', async () => {
      const originalConfig = {
        name: 'test-config',
        type: 'ws',
        _metadata: {
          filePath: '/path/to/config.json',
          fileName: 'config.json'
        }
      };

      const updatedConfig = {
        name: 'test-config',
        type: 'ws',
        description: 'Updated'
      };

      configManager.configs.set('test-config', originalConfig);

      // Mock schema loading
      fs.readFile
        .mockResolvedValueOnce('{"type": "object"}')
        .mockResolvedValueOnce('{"type": "object"}')
        .mockResolvedValueOnce(JSON.stringify(updatedConfig));

      await configManager.loadSchema();

      // Mock the loadSingleConfiguration method
      vi.spyOn(configManager, 'loadSingleConfiguration')
        .mockResolvedValue(updatedConfig);

      const result = await configManager.reloadConfiguration('test-config');

      expect(result).toEqual(updatedConfig);
      expect(configManager.configs.get('test-config')).toEqual(updatedConfig);
      expect(mockLogger.info).toHaveBeenCalledWith(
        { name: 'test-config' },
        'Configuration reloaded'
      );
    });

    it('should handle missing configuration gracefully', async () => {
      const result = await configManager.reloadConfiguration('nonexistent');

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { name: 'nonexistent' },
        'Configuration not found or missing metadata'
      );
    });
  });
});