// Test setup file
import { jest } from '@jest/globals';

// Mock global fetch if not available
if (!global.fetch) {
  global.fetch = jest.fn() as typeof fetch;
}

// Suppress console output in tests unless needed
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

beforeAll(() => {
  // Suppress console output by default
  console.log = jest.fn();
  console.error = jest.fn();
  console.warn = jest.fn();
});

afterAll(() => {
  // Restore console output
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
});





