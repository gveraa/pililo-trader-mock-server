import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test environment
    environment: 'node',

    // Global test timeout
    testTimeout: 10000,

    // Hook timeout
    hookTimeout: 10000,

    // Coverage configuration
    coverage: {
      provider: 'c8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'tests/**',
        'mocks/**',
        '*.config.js',
        'src/index.js',
        'src/validate.js'
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80
      }
    },

    // Globals
    globals: true,

    // Setup files
    // setupFiles: ['./tests/helpers/setup.js'],

    // Test file patterns
    include: ['tests/**/*.test.js'],

    // Exclude patterns
    exclude: ['node_modules', 'mocks/**'],

    // Reporter
    reporters: ['verbose'],

    // Parallel execution
    threads: true,
    maxThreads: 4,
    minThreads: 1,

    // Retry failed tests
    retry: 1,

    // Watch mode
    watch: false
  }
});