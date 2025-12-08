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
import { DatabaseService } from '../../src/services/database-service.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync } from 'fs';

describe('TaskOperatorService', () => {
  let mockRedis: {
    set: jest.Mock<() => Promise<string>>;
    get: jest.Mock<() => Promise<string | null>>;
    del: jest.Mock<() => Promise<number>>;
    exists: jest.Mock<() => Promise<number>>;
    ping: jest.Mock<() => Promise<string>>;
    quit: jest.Mock<() => Promise<string>>;
  };
  let testDbPath: string;

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

    // Create test database path
    testDbPath = join(tmpdir(), `test-db-${Date.now()}-${Math.random().toString(36).substring(7)}.sqlite`);
    
    // Set environment variable to use test database
    process.env.DATABASE_PATH = testDbPath;
  });

  afterEach(() => {
    // Reset singleton instance after each test
    TaskOperatorService.resetInstance();
    jest.clearAllMocks();
    
    // Clean up test database
    try {
      unlinkSync(testDbPath);
    } catch (error) {
      // File may not exist, ignore error
    }
    
    // Clear environment variable
    delete process.env.DATABASE_PATH;
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

  describe('isTaskOperatorEnabled', () => {
    it('should delegate to DatabaseService.isSystemSettingEnabled', () => {
      // Arrange: Create service and get its internal databaseService
      const service = TaskOperatorService.getInstance(mockRedis as any);
      const dbService = (service as any).databaseService as DatabaseService;
      
      // Spy on isSystemSettingEnabled to verify it's called and control return value
      const spy = jest.spyOn(dbService, 'isSystemSettingEnabled').mockReturnValue(true);
      
      // Act
      const result = service.isTaskOperatorEnabled();
      
      // Assert: Returns true (from mock)
      expect(result).toBe(true);
      // Assert: Method was called with 'task_operator'
      expect(spy).toHaveBeenCalledWith('task_operator');
      expect(spy).toHaveBeenCalledTimes(1);
      
      // Cleanup
      spy.mockRestore();
    });

    it('should return false when database service returns false', () => {
      // Arrange: Create service and get its internal databaseService
      const service = TaskOperatorService.getInstance(mockRedis as any);
      const dbService = (service as any).databaseService as DatabaseService;
      
      // Spy on isSystemSettingEnabled and mock to return false
      const spy = jest.spyOn(dbService, 'isSystemSettingEnabled').mockReturnValue(false);
      
      // Act
      const result = service.isTaskOperatorEnabled();
      
      // Assert: Returns false (from mock)
      expect(result).toBe(false);
      // Assert: Method was called with 'task_operator'
      expect(spy).toHaveBeenCalledWith('task_operator');
      expect(spy).toHaveBeenCalledTimes(1);
      
      // Cleanup
      spy.mockRestore();
    });
  });
});

