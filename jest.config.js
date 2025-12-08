export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@bull-board/api/bullMQAdapter\\.js$': '@bull-board/api/bullMQAdapter',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
  moduleFileExtensions: ['ts', 'js'],
  testMatch: ['**/tests/**/*.test.{js,ts}'],
  collectCoverageFrom: [
    'src/**/*.{js,ts}',
    '!src/index.{js,ts}',
    '!src/mcp/index.{js,ts}',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 80,
      statements: 80,
    },
    // Exclude mcp/server.ts from thresholds due to tool handler wrappers being hard to test
    // The private handler methods are well-tested, but the wrappers registered via registerTool
    // are difficult to test without invoking the full MCP protocol
    'src/mcp/server.ts': {
      branches: 35,
      functions: 50,
      lines: 35,
      statements: 35,
    },
  },
  verbose: true,
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
};

