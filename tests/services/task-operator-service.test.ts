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

    it('should process task successfully through happy path', async () => {
      // Arrange: Comprehensive mocks for happy path
      const sampleTask = { id: 1, prompt: 'test prompt', order: 0, uuid: 'test-uuid', status: 0 };
      mockRedis.set = jest.fn<() => Promise<string | null>>().mockResolvedValue('OK');
      
      const service = TaskOperatorService.getInstance(mockRedis as any);
      const dbService = (service as any).databaseService as DatabaseService;
      
      // Mock database service methods
      const getNextReadyTaskSpy = jest.spyOn(dbService, 'getNextReadyTask').mockReturnValue(sampleTask);
      const updateTaskStatusSpy = jest.spyOn(dbService, 'updateTaskStatus').mockReturnValue(true);
      
      // Mock fetch for conversation creation and async iterate
      const fetchMock = jest.fn<typeof fetch>();
      fetchMock
        .mockResolvedValueOnce({ // Conversation creation
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ conversationId: 'conv-123', success: true })),
        } as Response)
        .mockResolvedValueOnce({ // Async iterate
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ success: true })),
        } as Response);
      global.fetch = fetchMock as typeof fetch;
      
      // Mock cleanupStaleTasks to avoid issues
      const cleanupSpy = jest.spyOn(service as any, 'cleanupStaleTasks').mockResolvedValue(undefined);
      
      // Act
      const result = await service.processNextTask();
      
      // Assert: Returns success
      expect(result).toEqual({ processed: true, taskId: 1 });
      expect(getNextReadyTaskSpy).toHaveBeenCalled();
      expect(updateTaskStatusSpy).toHaveBeenCalledWith(1, 4); // IN_PROGRESS
      
      // Verify pending task entry was stored
      const pendingTasks = (service as any).pendingTasks;
      expect(pendingTasks.size).toBeGreaterThan(0);
      
      // Verify lock was NOT released (callback will release it)
      expect(mockRedis.del).not.toHaveBeenCalled();
      
      // Cleanup
      getNextReadyTaskSpy.mockRestore();
      updateTaskStatusSpy.mockRestore();
      cleanupSpy.mockRestore();
    });

    it('should reset task to ready and release lock when conversation creation fails', async () => {
      // Arrange: Mock conversation creation to fail
      const sampleTask = { id: 1, prompt: 'test prompt', order: 0, uuid: 'test-uuid', status: 0 };
      mockRedis.set = jest.fn<() => Promise<string | null>>().mockResolvedValue('OK');
      
      const service = TaskOperatorService.getInstance(mockRedis as any);
      const dbService = (service as any).databaseService as DatabaseService;
      
      // Mock database service methods
      const getNextReadyTaskSpy = jest.spyOn(dbService, 'getNextReadyTask').mockReturnValue(sampleTask);
      const updateTaskStatusSpy = jest.spyOn(dbService, 'updateTaskStatus').mockReturnValue(true);
      
      // Mock fetch to fail for conversation creation (both attempts)
      const fetchMock = jest.fn<typeof fetch>();
      fetchMock
        .mockRejectedValueOnce(new Error('Connection failed'))
        .mockRejectedValueOnce(new Error('Connection failed'));
      global.fetch = fetchMock as typeof fetch;
      
      // Mock cleanupStaleTasks
      const cleanupSpy = jest.spyOn(service as any, 'cleanupStaleTasks').mockResolvedValue(undefined);
      const releaseLockSpy = jest.spyOn(service as any, 'releaseLock').mockResolvedValue(undefined);
      
      // Act
      const result = await service.processNextTask();
      
      // Assert: Returns error
      expect(result).toEqual({
        processed: false,
        taskId: 1,
        error: expect.stringContaining('Failed to create new conversation'),
        reason: 'error',
      });
      expect(updateTaskStatusSpy).toHaveBeenCalledWith(1, 4); // IN_PROGRESS first
      expect(updateTaskStatusSpy).toHaveBeenCalledWith(1, 0); // Reset to ready
      expect(releaseLockSpy).toHaveBeenCalled();
      
      // Cleanup
      getNextReadyTaskSpy.mockRestore();
      updateTaskStatusSpy.mockRestore();
      cleanupSpy.mockRestore();
      releaseLockSpy.mockRestore();
    });

    it('should remove pending task and reset status when async iterate fails', async () => {
      // Arrange: Mock async iterate to fail
      const sampleTask = { id: 1, prompt: 'test prompt', order: 0, uuid: 'test-uuid', status: 0 };
      mockRedis.set = jest.fn<() => Promise<string | null>>().mockResolvedValue('OK');
      
      const service = TaskOperatorService.getInstance(mockRedis as any);
      const dbService = (service as any).databaseService as DatabaseService;
      
      // Mock database service methods
      const getNextReadyTaskSpy = jest.spyOn(dbService, 'getNextReadyTask').mockReturnValue(sampleTask);
      const updateTaskStatusSpy = jest.spyOn(dbService, 'updateTaskStatus').mockReturnValue(true);
      
      // Mock fetch: conversation creation succeeds, async iterate fails
      const fetchMock = jest.fn<typeof fetch>();
      fetchMock
        .mockResolvedValueOnce({ // Conversation creation succeeds
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ conversationId: 'conv-123', success: true })),
        } as Response)
        .mockResolvedValueOnce({ // Async iterate fails
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          text: () => Promise.resolve('Internal Server Error'),
        } as Response);
      global.fetch = fetchMock as typeof fetch;
      
      // Mock cleanupStaleTasks
      const cleanupSpy = jest.spyOn(service as any, 'cleanupStaleTasks').mockResolvedValue(undefined);
      const releaseLockSpy = jest.spyOn(service as any, 'releaseLock').mockResolvedValue(undefined);
      
      // Act
      const result = await service.processNextTask();
      
      // Assert: Returns error
      expect(result).toEqual({
        processed: false,
        taskId: 1,
        error: expect.stringContaining('Cursor runner returned 500'),
        reason: 'error',
      });
      
      // Verify pending task was removed
      const pendingTasks = (service as any).pendingTasks;
      expect(pendingTasks.size).toBe(0);
      
      // Verify task status was reset to ready
      expect(updateTaskStatusSpy).toHaveBeenCalledWith(1, 0);
      
      // Verify lock was released
      expect(releaseLockSpy).toHaveBeenCalled();
      
      // Cleanup
      getNextReadyTaskSpy.mockRestore();
      updateTaskStatusSpy.mockRestore();
      cleanupSpy.mockRestore();
      releaseLockSpy.mockRestore();
    });
  });

  describe('handleCallback', () => {
    it('should clear foreign lock for unknown requestId', async () => {
      // Arrange: Unknown requestId, foreign lock
      const unknownRequestId = 'unknown-request-id';
      const foreignPid = 99999; // Different PID
      const foreignLockValue = `${foreignPid}-${Date.now()}-random`;
      
      mockRedis.get = jest.fn<() => Promise<string | null>>().mockResolvedValue(foreignLockValue);
      mockRedis.del = jest.fn<() => Promise<number>>().mockResolvedValue(1);
      
      const service = TaskOperatorService.getInstance(mockRedis as any);
      const dbService = (service as any).databaseService as DatabaseService;
      
      // Ensure pendingTasks is empty
      const pendingTasks = (service as any).pendingTasks;
      pendingTasks.clear();
      
      // Mock database service methods (should not be called)
      const markTaskCompleteSpy = jest.spyOn(dbService, 'markTaskComplete');
      const updateTaskStatusSpy = jest.spyOn(dbService, 'updateTaskStatus');
      
      // Mock clearLock
      const clearLockSpy = jest.spyOn(service, 'clearLock').mockResolvedValue(true);
      
      // Act
      await service.handleCallback(unknownRequestId, { success: true });
      
      // Assert: clearLock was called
      expect(clearLockSpy).toHaveBeenCalled();
      
      // Assert: No database changes occurred
      expect(markTaskCompleteSpy).not.toHaveBeenCalled();
      expect(updateTaskStatusSpy).not.toHaveBeenCalled();
      
      // Cleanup
      markTaskCompleteSpy.mockRestore();
      updateTaskStatusSpy.mockRestore();
      clearLockSpy.mockRestore();
    });

    it('should mark task complete and release lock on successful callback', async () => {
      // Arrange: Seed pendingTasks, mock success
      const requestId = 'req-123';
      const taskId = 1;
      const currentPid = process.pid;
      const lockValue = `${currentPid}-${Date.now()}-random`;
      
      mockRedis.get = jest.fn<() => Promise<string | null>>().mockResolvedValue(lockValue);
      
      const service = TaskOperatorService.getInstance(mockRedis as any);
      const dbService = (service as any).databaseService as DatabaseService;
      
      // Seed pendingTasks
      const pendingTasks = (service as any).pendingTasks;
      pendingTasks.set(requestId, { taskId, requestId, timestamp: Date.now() });
      
      // Mock database service
      const markTaskCompleteSpy = jest.spyOn(dbService, 'markTaskComplete').mockReturnValue(true);
      
      // Mock releaseLock
      const releaseLockSpy = jest.spyOn(service as any, 'releaseLock').mockResolvedValue(undefined);
      
      // Act
      await service.handleCallback(requestId, { success: true, iterations: 3 });
      
      // Assert: Task was marked complete
      expect(markTaskCompleteSpy).toHaveBeenCalledWith(taskId);
      
      // Assert: Pending task entry was removed
      expect(pendingTasks.has(requestId)).toBe(false);
      
      // Assert: Lock was released
      expect(releaseLockSpy).toHaveBeenCalled();
      
      // Cleanup
      markTaskCompleteSpy.mockRestore();
      releaseLockSpy.mockRestore();
    });

    it('should reset task to ready and release lock on failed callback', async () => {
      // Arrange: Seed pendingTasks, mock failure
      const requestId = 'req-123';
      const taskId = 1;
      const currentPid = process.pid;
      const lockValue = `${currentPid}-${Date.now()}-random`;
      
      mockRedis.get = jest.fn<() => Promise<string | null>>().mockResolvedValue(lockValue);
      
      const service = TaskOperatorService.getInstance(mockRedis as any);
      const dbService = (service as any).databaseService as DatabaseService;
      
      // Seed pendingTasks
      const pendingTasks = (service as any).pendingTasks;
      pendingTasks.set(requestId, { taskId, requestId, timestamp: Date.now() });
      
      // Mock database service
      const updateTaskStatusSpy = jest.spyOn(dbService, 'updateTaskStatus').mockReturnValue(true);
      
      // Mock releaseLock
      const releaseLockSpy = jest.spyOn(service as any, 'releaseLock').mockResolvedValue(undefined);
      
      // Act
      await service.handleCallback(requestId, { success: false, error: 'boom' });
      
      // Assert: Task was reset to ready (STATUS_READY = 0)
      expect(updateTaskStatusSpy).toHaveBeenCalledWith(taskId, 0);
      
      // Assert: Pending task entry was removed
      expect(pendingTasks.has(requestId)).toBe(false);
      
      // Assert: Lock was released
      expect(releaseLockSpy).toHaveBeenCalled();
      
      // Cleanup
      updateTaskStatusSpy.mockRestore();
      releaseLockSpy.mockRestore();
    });
  });
});

