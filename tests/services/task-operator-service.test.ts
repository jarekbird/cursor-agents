/**
 * Tests for TaskOperatorService
 * 
 * This test suite covers all task operator operations including:
 * - Task processing with Redis-based distributed locking
 * - Callback handling for async task execution
 * - Integration with DatabaseService and Redis
 * - Singleton pattern management
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { TaskOperatorService } from '../../src/services/task-operator-service.js';

describe('TaskOperatorService', () => {
  let mockRedis: {
    set: jest.Mock<() => Promise<string>>;
    get: jest.Mock<() => Promise<string | null>>;
    del: jest.Mock<() => Promise<number>>;
    exists: jest.Mock<() => Promise<number>>;
    ping: jest.Mock<() => Promise<string>>;
    quit: jest.Mock<() => Promise<string>>;
  };

  beforeEach(() => {
    // Reset singleton instance before each test
    TaskOperatorService.resetInstance();
    
    // Clear all mocks
    jest.clearAllMocks();

    // Setup mock Redis
    mockRedis = {
      set: jest.fn<() => Promise<string>>().mockResolvedValue('OK'),
      get: jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
      del: jest.fn<() => Promise<number>>().mockResolvedValue(1),
      exists: jest.fn<() => Promise<number>>().mockResolvedValue(0),
      ping: jest.fn<() => Promise<string>>().mockResolvedValue('PONG'),
      quit: jest.fn<() => Promise<string>>().mockResolvedValue('OK'),
    };

    // Note: DatabaseService mocking will be added in subsequent tasks
  });

  afterEach(() => {
    // Reset singleton instance after each test
    TaskOperatorService.resetInstance();
    jest.clearAllMocks();
  });

  it('should have test file structure', () => {
    const service = TaskOperatorService.getInstance(mockRedis as any);
    expect(service).toBeInstanceOf(TaskOperatorService);
  });
});

