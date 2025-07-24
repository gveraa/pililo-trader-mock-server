#!/usr/bin/env node

const pino = require('pino');
const ConfigurationManager = require('./modules/ConfigurationManager');
const path = require('path');

// Create logger for validation
const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss Z',
      ignore: 'pid,hostname'
    }
  }
});

/**
 * Validate all configuration files
 */
async function validateConfigurations() {
  const configManager = new ConfigurationManager(logger);
  const configDir = process.argv[2] || 'mocks';

  console.log(`\nValidating configurations in: ${path.join(process.cwd(), configDir)}\n`);

  try {
    // Load schema
    await configManager.loadSchema();

    // Load and validate configurations
    const results = await configManager.loadConfigurations(configDir, {
      validateOnly: true,
      stopOnError: false
    });

    // Display results
    console.log('\n=== Validation Summary ===\n');
    console.log(`Total files found: ${results.summary.total}`);
    console.log(`Valid configurations: ${results.summary.loaded}`);
    console.log(`Invalid configurations: ${results.summary.failed}`);

    if (results.summary.loaded > 0) {
      console.log('\n✓ Valid configurations:');
      results.configurations.forEach(config => {
        const details = config.type === 'ws' 
          ? `WebSocket - ${config.scheduledMessages?.length || 0} scheduled, ${config.responseRules?.length || 0} rules`
          : `API - ${config.mappings?.length || 0} mappings`;
        console.log(`  - ${config.name} (${config.type}): ${details}`);
      });
    }

    if (results.summary.failed > 0) {
      console.log('\n✗ Validation errors:');
      results.summary.errors.forEach(error => {
        console.log(`\n  File: ${error.file}`);
        console.log(`  Error: ${error.error}`);
      });
      process.exit(1);
    } else {
      console.log('\n✅ All configurations are valid!\n');
      process.exit(0);
    }
  } catch (error) {
    logger.error({ error: error.message }, 'Validation failed');
    process.exit(1);
  }
}

// Run validation
validateConfigurations();