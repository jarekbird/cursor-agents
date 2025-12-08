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
    set: jest.Mock<() => Promise<string | null>>;
    get: jest.Mock<() => Promise<string | null>>;
    del: jest.Mock<() => Promise<number>>;
    exists: jest.Mock<() => Promise<number>>;
    ping: jest.Mock<() => Promise<string>>;
    quit: jest.Mock<() => Promise<string>>;
    ttl?: jest.Mock<() => Promise<number>>;
  };
  let testDbPath: string;

  beforeEach(() => {
    // Reset singleton instance before each test
    TaskOperatorService.resetInstance();
    
    // Clear all mocks
    jest.clearAllMocks();

    // Setup mock Redis
    mockRedis = {
      set: jest.fn<() => Promise<string | null>>().mockResolvedValue('OK'),
      get: jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
      del: jest.fn<() => Promise<number>>().mockResolvedValue(1),
      exists: jest.fn<() => Promise<number>>().mockResolvedValue(0),
      ping: jest.fn<() => Promise<string>>().mockResolvedValue('PONG'),
      quit: jest.fn<() => Promise<string>>().mockResolvedValue('OK'),
      ttl: jest.fn<() => Promise<number>>().mockResolvedValue(3600),
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

  describe('processNextTask', () => {
    it('should return lock_held when lock acquisition fails', async () => {
      // Arrange: Mock Redis set to return null (lock held by another process)
      mockRedis.set = jest.fn<() => Promise<string | null>>().mockResolvedValue(null);
      mockRedis.get = jest.fn<() => Promise<string | null>>().mockResolvedValue('other-pid-12345');
      mockRedis.ttl = jest.fn<() => Promise<number>>().mockResolvedValue(3600);
      
      const service = TaskOperatorService.getInstance(mockRedis as any);
      
      // Mock logger to verify it's called
      const logger = await import('../../src/logger.js');
      const infoSpy = jest.spyOn(logger.logger, 'info').mockImplementation(() => logger.logger);
      
      // Act
      const result = await service.processNextTask();
      
      // Assert: Returns lock_held
      expect(result).toEqual({ processed: false, reason: 'lock_held' });
      expect(mockRedis.set).toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalled();
      
      // Cleanup
      infoSpy.mockRestore();
    });

    it('should return no_tasks when no tasks are available', async () => {
      // Arrange: Mock Redis lock success, DatabaseService returns null
      mockRedis.set = jest.fn<() => Promise<string | null>>().mockResolvedValue('OK');
      mockRedis.del = jest.fn<() => Promise<number>>().mockResolvedValue(1);
      
      const service = TaskOperatorService.getInstance(mockRedis as any);
      const dbService = (service as any).databaseService as DatabaseService;
      
      // Mock getNextReadyTask to return null
      const getNextReadyTaskSpy = jest.spyOn(dbService, 'getNextReadyTask').mockReturnValue(null);
      
      // Mock releaseLock by spying on redis.del
      const releaseLockSpy = jest.spyOn(service as any, 'releaseLock').mockResolvedValue(undefined);
      
      // Act
      const result = await service.processNextTask();
      
      // Assert: Returns no_tasks
      expect(result).toEqual({ processed: false, reason: 'no_tasks' });
      expect(getNextReadyTaskSpy).toHaveBeenCalled();
      expect(releaseLockSpy).toHaveBeenCalled();
      
      // Cleanup
      getNextReadyTaskSpy.mockRestore();
      releaseLockSpy.mockRestore();
    });
  });
});

