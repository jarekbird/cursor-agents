import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { QueueManager, type QueueFactory, type WorkerFactory, type QueueEventsFactory } from '../../src/queue/queue-manager.js';
import type { AgentConfig, RecurringPromptOptions } from '../../src/queue/queue-manager.js';
import { Queue, Worker, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { logger } from '../../src/logger.js';

// Create mock instances
const mockQueueInstance = {
  add: jest.fn(),
  removeRepeatableByKey: jest.fn(),
  getRepeatableJobs: jest.fn(),
  getCompleted: jest.fn(),
  getWaiting: jest.fn(),
  getActive: jest.fn(),
  getDelayed: jest.fn(),
  getWaitingCount: jest.fn(),
  getActiveCount: jest.fn(),
  getDelayedCount: jest.fn(),
  close: jest.fn(),
};

const mockWorkerInstance = {
  on: jest.fn(),
  close: jest.fn(),
};

const mockQueueEventsInstance = {
  close: jest.fn(),
};

const mockRedisInstance = {
  ping: jest.fn(),
  quit: jest.fn(),
};

describe('QueueManager', () => {
  let queueManager: QueueManager;
  let mockQueueFactory: jest.MockedFunction<QueueFactory>;
  let mockWorkerFactory: jest.MockedFunction<WorkerFactory>;
  let mockQueueEventsFactory: jest.MockedFunction<QueueEventsFactory>;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Setup mock factories
    mockQueueFactory = jest.fn<QueueFactory>().mockReturnValue(mockQueueInstance as unknown as Queue);
    mockWorkerFactory = jest.fn<WorkerFactory>().mockReturnValue(mockWorkerInstance as unknown as Worker);
    mockQueueEventsFactory = jest.fn<QueueEventsFactory>().mockReturnValue(mockQueueEventsInstance as unknown as QueueEvents);

    // Setup mock instances to return proper values
    // The add method should return a job with the name passed as first argument
    (mockQueueInstance.add as jest.Mock<(...args: unknown[]) => Promise<{ id: string; name: string }>>).mockImplementation(
      async (name: unknown) => ({
        id: 'job-123',
        name: name as string,
      })
    );
    (mockQueueInstance.removeRepeatableByKey as jest.Mock<() => Promise<void>>).mockResolvedValue(undefined);
    (mockQueueInstance.getRepeatableJobs as jest.Mock<() => Promise<unknown[]>>).mockResolvedValue([]);
    (mockQueueInstance.getCompleted as jest.Mock<() => Promise<unknown[]>>).mockResolvedValue([]);
    (mockQueueInstance.getWaiting as jest.Mock<() => Promise<unknown[]>>).mockResolvedValue([]);
    (mockQueueInstance.getActive as jest.Mock<() => Promise<unknown[]>>).mockResolvedValue([]);
    (mockQueueInstance.getDelayed as jest.Mock<() => Promise<unknown[]>>).mockResolvedValue([]);
    (mockQueueInstance.getWaitingCount as jest.Mock<() => Promise<number>>).mockResolvedValue(0);
    (mockQueueInstance.getActiveCount as jest.Mock<() => Promise<number>>).mockResolvedValue(0);
    (mockQueueInstance.getDelayedCount as jest.Mock<() => Promise<number>>).mockResolvedValue(0);
    (mockQueueInstance.close as jest.Mock<() => Promise<void>>).mockResolvedValue(undefined);
    (mockWorkerInstance.close as jest.Mock<() => Promise<void>>).mockResolvedValue(undefined);
    (mockQueueEventsInstance.close as jest.Mock<() => Promise<void>>).mockResolvedValue(undefined);
    (mockRedisInstance.ping as jest.Mock<() => Promise<string>>).mockResolvedValue('PONG');
    (mockRedisInstance.quit as jest.Mock<() => Promise<string>>).mockResolvedValue('OK');

    process.env.REDIS_URL = 'redis://localhost:6379/0';
    // Create QueueManager with mock factories
    queueManager = new QueueManager(
      mockRedisInstance as unknown as Redis,
      undefined,
      mockQueueFactory,
      mockWorkerFactory,
      mockQueueEventsFactory
    );
  });

  afterEach(async () => {
    if (queueManager) {
      try {
        await queueManager.shutdown();
      } catch (error) {
        // Ignore shutdown errors in tests
      }
    }
    // Clear all mocks
    jest.clearAllMocks();
  });

  describe('initialize', () => {
    it('should initialize successfully', async () => {
      await expect(queueManager.initialize()).resolves.not.toThrow();
      expect(mockRedisInstance.ping).toHaveBeenCalled();
    });

    it('should throw error if Redis connection fails', async () => {
      (mockRedisInstance.ping as jest.Mock<() => Promise<string>>).mockRejectedValueOnce(
        new Error('Connection failed')
      );

      await expect(queueManager.initialize()).rejects.toThrow('Connection failed');
    });

    it('should discover and recreate queues from Redis keys', async () => {
      // Arrange: Mock Redis scan to return queue keys
      // loadExistingQueues does 4 separate scans: meta, delayed, wait, active
      // Each scan can have multiple pages (cursor != '0'), but we'll mock single-page results
      const mockScan = jest.fn<(...args: unknown[]) => Promise<[string, string[]]>>()
        // First scan: bull:*:meta (returns queue1 and queue3)
        .mockResolvedValueOnce(['0', ['bull:queue1:meta', 'bull:queue3:meta']])
        // Second scan: bull:*:delayed (returns queue2)
        .mockResolvedValueOnce(['0', ['bull:queue2:delayed']])
        // Third scan: bull:*:wait (returns empty)
        .mockResolvedValueOnce(['0', []])
        // Fourth scan: bull:*:active (returns empty)
        .mockResolvedValueOnce(['0', []]);
      
      (mockRedisInstance as any).scan = mockScan;
      
      // Act
      await queueManager.initialize();
      
      // Assert: Scan was called 4 times (once for each pattern)
      expect(mockScan).toHaveBeenCalledTimes(4);
      // Verify factories were called for each discovered queue (queue1, queue2, queue3)
      expect(mockQueueFactory).toHaveBeenCalledWith('queue1', expect.any(Object));
      expect(mockQueueFactory).toHaveBeenCalledWith('queue2', expect.any(Object));
      expect(mockQueueFactory).toHaveBeenCalledWith('queue3', expect.any(Object));
      expect(mockWorkerFactory).toHaveBeenCalled();
      expect(mockQueueEventsFactory).toHaveBeenCalled();
    });

    it('should continue processing when individual queue recreation fails', async () => {
      // Arrange: One queue fails, others succeed
      const mockScan = jest.fn<(...args: unknown[]) => Promise<[string, string[]]>>()
        .mockResolvedValueOnce(['0', ['bull:queue1:meta', 'bull:queue2:meta']])
        .mockResolvedValueOnce(['0', []]) // delayed
        .mockResolvedValueOnce(['0', []]) // wait
        .mockResolvedValueOnce(['0', []]); // active
      
      (mockRedisInstance as any).scan = mockScan;
      
      // Make queueFactory throw for queue1 but succeed for queue2
      let callCount = 0;
      const failingQueueFactory = jest.fn<QueueFactory>().mockImplementation((name) => {
        callCount++;
        if (name === 'queue1') {
          throw new Error('Failed to create queue1');
        }
        return mockQueueFactory(name);
      });
      
      const queueManagerWithFailingFactory = new QueueManager(
        mockRedisInstance as unknown as Redis,
        undefined,
        failingQueueFactory,
        mockWorkerFactory,
        mockQueueEventsFactory
      );
      
      const loggerErrorSpy = jest.spyOn(logger, 'error');
      
      // Act
      await queueManagerWithFailingFactory.initialize();
      
      // Assert: Error logged, but process continued and queue2 was created
      expect(loggerErrorSpy).toHaveBeenCalled();
      expect(failingQueueFactory).toHaveBeenCalledWith('queue1', expect.any(Object));
      expect(failingQueueFactory).toHaveBeenCalledWith('queue2', expect.any(Object));
      
      // Cleanup
      loggerErrorSpy.mockRestore();
      try {
        await queueManagerWithFailingFactory.shutdown();
      } catch (error) {
        // Ignore shutdown errors
      }
    });
  });

  describe('addRecurringPrompt', () => {
    it('should add a recurring prompt job', async () => {
      const options: RecurringPromptOptions = {
        name: 'test-prompt',
        prompt: 'Test prompt',
        schedule: '0 */5 * * * *',
      };

      await queueManager.initialize();
      const result = await queueManager.addRecurringPrompt(options);

      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('name', 'test-prompt');
      expect(mockQueueFactory).toHaveBeenCalledWith('test-prompt', expect.objectContaining({ connection: mockRedisInstance }));
      expect(mockWorkerFactory).toHaveBeenCalled();
      expect(mockQueueEventsFactory).toHaveBeenCalled();
      expect(mockQueueInstance.add).toHaveBeenCalled();
    });

    it('should create queue and worker if they do not exist', async () => {
      const options: RecurringPromptOptions = {
        name: 'new-prompt',
        prompt: 'New prompt',
        schedule: '0 */5 * * * *',
      };

      jest.clearAllMocks();

      await queueManager.initialize();
      await queueManager.addRecurringPrompt(options);

      expect(mockQueueFactory).toHaveBeenCalled();
      expect(mockWorkerFactory).toHaveBeenCalled();
      expect(mockQueueEventsFactory).toHaveBeenCalled();
    });
  });

  describe('addOneTimeAgent', () => {
    it('should add a one-time agent job', async () => {
      const config: AgentConfig = {
        name: 'test-agent',
        targetUrl: 'http://example.com/api',
        method: 'GET',
        oneTime: true,
      };

      await queueManager.initialize();
      const result = await queueManager.addOneTimeAgent(config);

      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('name', 'test-agent');
      expect(mockQueueInstance.add).toHaveBeenCalledWith(
        'test-agent',
        expect.objectContaining({ targetUrl: 'http://example.com/api', method: 'GET' }),
        expect.any(Object)
      );
    });

    it('should include timeout in job data', async () => {
      const config: AgentConfig = {
        name: 'test-agent',
        targetUrl: 'http://example.com/api',
        method: 'POST',
        timeout: 10000,
        oneTime: true,
      };

      await queueManager.initialize();
      await queueManager.addOneTimeAgent(config);

      expect(mockQueueInstance.add).toHaveBeenCalledWith(
        'test-agent',
        expect.objectContaining({
          timeout: 10000,
        }),
        expect.any(Object)
      );
    });
  });

  describe('addRecurringAgent', () => {
    it('should add a recurring agent job', async () => {
      const config: AgentConfig = {
        name: 'recurring-agent',
        targetUrl: 'http://example.com/api',
        method: 'GET',
        schedule: '0 */5 * * * *',
      };

      await queueManager.initialize();
      const result = await queueManager.addRecurringAgent(config);

      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('name', 'recurring-agent');
      expect(mockQueueInstance.add).toHaveBeenCalledWith(
        'recurring-agent',
        expect.objectContaining({ targetUrl: 'http://example.com/api', method: 'GET' }),
        expect.any(Object)
      );
    });

    it('should throw error if schedule is missing', async () => {
      const config: AgentConfig = {
        name: 'recurring-agent',
        targetUrl: 'http://example.com/api',
        method: 'GET',
      };

      await queueManager.initialize();

      await expect(queueManager.addRecurringAgent(config)).rejects.toThrow(
        'Schedule is required'
      );
    });
  });

  describe('getPromptStatus', () => {
    it('should return null for non-existent prompt', async () => {
      await queueManager.initialize();
      const status = await queueManager.getPromptStatus('non-existent');

      expect(status).toBeNull();
    });

    it('should return status for existing prompt', async () => {
      const options: RecurringPromptOptions = {
        name: 'test-prompt',
        prompt: 'Test prompt',
        schedule: '0 */5 * * * *',
      };

      await queueManager.initialize();
      await queueManager.addRecurringPrompt(options);
      
      // Mock getRepeatableJobs to return the job (using the correct jobId format)
      (mockQueueInstance.getRepeatableJobs as jest.Mock<() => Promise<unknown[]>>).mockResolvedValueOnce([
        {
          id: 'recurring:test-prompt',
          key: 'recurring:test-prompt',
          name: 'test-prompt',
          next: Date.now() + 10000,
          endDate: null,
          tz: null,
          pattern: '0 */5 * * * *',
        },
      ]);
      
      const status = await queueManager.getPromptStatus('test-prompt');

      expect(status).not.toBeNull();
      expect(status?.name).toBe('test-prompt');
      expect(status?.isActive).toBe(true);
    });
  });

  describe('removeRecurringPrompt', () => {
    it('should remove a prompt successfully', async () => {
      const options: RecurringPromptOptions = {
        name: 'test-prompt',
        prompt: 'Test prompt',
        schedule: '0 */5 * * * *',
      };

      await queueManager.initialize();
      await queueManager.addRecurringPrompt(options);
      await queueManager.removeRecurringPrompt('test-prompt');

      expect(mockQueueInstance.removeRepeatableByKey).toHaveBeenCalled();
      expect(mockWorkerInstance.close).toHaveBeenCalled();
      expect(mockQueueEventsInstance.close).toHaveBeenCalled();
      expect(mockQueueInstance.close).toHaveBeenCalled();
    });

    it('should throw error if prompt does not exist', async () => {
      await queueManager.initialize();

      await expect(queueManager.removeRecurringPrompt('non-existent')).rejects.toThrow(
        'Queue non-existent not found'
      );
    });
  });

  describe('listQueues', () => {
    it('should return empty array initially', async () => {
      await queueManager.initialize();
      const queues = await queueManager.listQueues();

      expect(queues).toEqual([]);
    });

    it('should return list of queue names', async () => {
      const options: RecurringPromptOptions = {
        name: 'test-prompt',
        prompt: 'Test prompt',
        schedule: '0 */5 * * * *',
      };

      await queueManager.initialize();
      await queueManager.addRecurringPrompt(options);
      const queues = await queueManager.listQueues();

      expect(queues).toContain('test-prompt');
    });
  });

  describe('getQueues', () => {
    it('should return all queue instances', async () => {
      const options: RecurringPromptOptions = {
        name: 'test-prompt',
        prompt: 'Test prompt',
        schedule: '0 */5 * * * *',
      };

      await queueManager.initialize();
      await queueManager.addRecurringPrompt(options);
      const queues = queueManager.getQueues();

      expect(queues).toHaveLength(1);
      expect(queues[0]).toBe(mockQueueInstance);
    });
  });

  describe('hasExistingJobs', () => {
    it('should return true when matching jobs exist and excludeActive is false', async () => {
      // Arrange: Create a queue and add it to queueManager
      const queueName = 'test-queue';
      const queue = (queueManager as any).getOrCreateQueue(queueName);
      
      // Mock queue methods to return matching jobs
      (queue.getWaiting as any).mockResolvedValue([
        { id: '1', name: 'agent:test', data: {} },
      ]);
      (queue.getActive as any).mockResolvedValue([]);
      (queue.getDelayed as any).mockResolvedValue([]);
      
      // Act
      const result = await queueManager.hasExistingJobs('agent:test', queueName, false);
      
      // Assert
      expect(result).toBe(true);
      expect(queue.getWaiting).toHaveBeenCalled();
      expect(queue.getActive).toHaveBeenCalled();
      expect(queue.getDelayed).toHaveBeenCalled();
    });

    it('should return false when only active jobs match and excludeActive is true', async () => {
      // Arrange: Create a queue and add it to queueManager
      const queueName = 'test-queue-2';
      const queue = (queueManager as any).getOrCreateQueue(queueName);
      
      // Mock queue methods - only active jobs match
      (queue.getWaiting as any).mockResolvedValue([]);
      (queue.getActive as any).mockResolvedValue([
        { id: '1', name: 'agent:test', data: {} },
      ]);
      (queue.getDelayed as any).mockResolvedValue([]);
      
      // Act
      const result = await queueManager.hasExistingJobs('agent:test', queueName, true);
      
      // Assert
      expect(result).toBe(false);
      expect(queue.getWaiting).toHaveBeenCalled();
      expect(queue.getActive).toHaveBeenCalled();
      expect(queue.getDelayed).toHaveBeenCalled();
    });

    it('should return false and log error when BullMQ methods throw', async () => {
      // Arrange: Create a queue and add it to queueManager
      const queueName = 'test-queue-3';
      const queue = (queueManager as any).getOrCreateQueue(queueName);
      
      // Mock queue methods to throw
      (queue.getWaiting as any).mockRejectedValue(new Error('Redis error'));
      (queue.getActive as any).mockResolvedValue([]);
      (queue.getDelayed as any).mockResolvedValue([]);
      
      const loggerErrorSpy = jest.spyOn(logger, 'error');
      
      // Act
      const result = await queueManager.hasExistingJobs('agent:test', queueName, false);
      
      // Assert
      expect(result).toBe(false);
      expect(loggerErrorSpy).toHaveBeenCalled();
      
      // Cleanup
      loggerErrorSpy.mockRestore();
    });
  });

  describe('addDelayedAgent', () => {
    it('should add delayed job for non-task-operator queue', async () => {
      // Arrange: Non-task-operator queue
      const config = {
        name: 'test-agent',
        targetUrl: 'http://example.com',
        method: 'POST' as const,
        delay: 5000,
      };
      const queueName = 'default';
      
      // Ensure queue exists
      const queue = (queueManager as any).getOrCreateQueue(queueName);
      jest.clearAllMocks();
      
      // Act
      const result = await queueManager.addDelayedAgent(config);
      
      // Assert
      expect(result).toBeDefined();
      expect(result?.id).toBe('job-123');
      expect(result?.name).toBe('test-agent');
      expect(queue.add).toHaveBeenCalledWith(
        'test-agent',
        expect.objectContaining({
          agentName: 'test-agent',
          targetUrl: 'http://example.com',
          method: 'POST',
        }),
        expect.objectContaining({
          delay: 5000,
        })
      );
    });

    it('should return null and log skip for task-operator when jobs exist', async () => {
      // Arrange: task-operator queue, hasExistingJobs returns true
      const queueName = 'task-operator';
      const config = {
        name: 'task-operator',
        targetUrl: 'task-operator://internal',
        delay: 5000,
        queue: queueName,
      };
      
      // Ensure queue exists
      const queue = (queueManager as any).getOrCreateQueue(queueName);
      
      // Mock hasExistingJobs to return true
      const hasExistingJobsSpy = jest.spyOn(queueManager, 'hasExistingJobs').mockResolvedValue(true);
      const loggerDebugSpy = jest.spyOn(logger, 'debug');
      
      jest.clearAllMocks();
      
      // Act
      const result = await queueManager.addDelayedAgent(config);
      
      // Assert
      expect(result).toBeNull();
      expect(hasExistingJobsSpy).toHaveBeenCalledWith('task-operator', queueName, true);
      expect(loggerDebugSpy).toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
      
      // Cleanup
      hasExistingJobsSpy.mockRestore();
      loggerDebugSpy.mockRestore();
    });

    it('should add delayed job for task-operator when no jobs exist', async () => {
      // Arrange: task-operator queue, hasExistingJobs returns false
      const queueName = 'task-operator';
      const config = {
        name: 'task-operator',
        targetUrl: 'task-operator://internal',
        delay: 5000,
        queue: queueName,
      };
      
      // Ensure queue exists
      const queue = (queueManager as any).getOrCreateQueue(queueName);
      
      // Mock hasExistingJobs to return false
      const hasExistingJobsSpy = jest.spyOn(queueManager, 'hasExistingJobs').mockResolvedValue(false);
      
      jest.clearAllMocks();
      
      // Act
      const result = await queueManager.addDelayedAgent(config);
      
      // Assert
      expect(result).toBeDefined();
      expect(result?.id).toBe('job-123');
      expect(result?.name).toBe('task-operator');
      expect(hasExistingJobsSpy).toHaveBeenCalledWith('task-operator', queueName, true);
      expect(queue.add).toHaveBeenCalledWith(
        'task-operator',
        expect.objectContaining({
          agentName: 'task-operator',
          targetUrl: 'task-operator://internal',
        }),
        expect.objectContaining({
          delay: 5000,
        })
      );
      
      // Cleanup
      hasExistingJobsSpy.mockRestore();
    });
  });

  describe('getAgentStatus', () => {
    it('should return null when agent is not found', async () => {
      // Arrange: Mock queues with no matching jobs
      await queueManager.initialize();
      
      // Act
      const result = await queueManager.getAgentStatus('non-existent-agent');
      
      // Assert
      expect(result).toBeNull();
    });

    it('should return complete AgentStatus when agent is found', async () => {
      // Arrange: Create queue and add recurring agent
      await queueManager.initialize();
      const agentConfig = {
        name: 'test-agent',
        targetUrl: 'http://example.com',
        method: 'POST' as const,
        headers: { 'Content-Type': 'application/json' },
        body: { test: 'data' },
        timeout: 5000,
        schedule: '0 */5 * * * *',
        queue: 'default',
      };
      
      await queueManager.addRecurringAgent(agentConfig);
      
      // Mock the queue to return repeatable job and recent job data
      const queue = (queueManager as any).getOrCreateQueue('default');
      (queue.getRepeatableJobs as any).mockResolvedValue([
        { id: 'agent:test-agent', key: 'agent:test-agent', pattern: '0 */5 * * * *', next: Date.now() + 300000 },
      ]);
      (queue.getWaiting as any).mockResolvedValue([
        { id: '1', name: 'test-agent', data: { agentName: 'test-agent', targetUrl: 'http://example.com', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { test: 'data' }, timeout: 5000 } },
      ]);
      
      // Act
      const result = await queueManager.getAgentStatus('test-agent');
      
      // Assert
      expect(result).not.toBeNull();
      expect(result?.name).toBe('test-agent');
      expect(result?.targetUrl).toBe('http://example.com');
      expect(result?.method).toBe('POST');
      expect(result?.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(result?.body).toEqual({ test: 'data' });
      expect(result?.timeout).toBe(5000);
      expect(result?.schedule).toBe('0 */5 * * * *');
      expect(result?.isActive).toBe(true);
      expect(result?.queue).toBe('default');
    });

    it('should find agent by job name', async () => {
      // Arrange: Create queue and add agent with job name matching
      await queueManager.initialize();
      const agentConfig = {
        name: 'test-agent-name',
        targetUrl: 'http://example.com',
        schedule: '0 */5 * * * *',
      };
      
      await queueManager.addRecurringAgent(agentConfig);
      
      // Mock the queue to return repeatable job
      const queue = (queueManager as any).getOrCreateQueue('default');
      (queue.getRepeatableJobs as any).mockResolvedValue([
        { id: 'agent:test-agent-name', key: 'agent:test-agent-name', pattern: '0 */5 * * * *' },
      ]);
      
      // Act
      const result = await queueManager.getAgentStatus('test-agent-name');
      
      // Assert
      expect(result).not.toBeNull();
      expect(result?.name).toBe('test-agent-name');
    });

    it('should find agent by agentName in job data', async () => {
      // Arrange: Create queue and add recurring agent (which uses agentName in data)
      await queueManager.initialize();
      const recurringConfig = {
        name: 'test-agent-data',
        targetUrl: 'http://example.com',
        schedule: '0 */5 * * * *',
      };
      
      await queueManager.addRecurringAgent(recurringConfig);
      
      // Mock the queue to return jobs with agentName in data
      const queue = (queueManager as any).getOrCreateQueue('default');
      (queue.getWaiting as any).mockResolvedValue([
        { id: '1', name: 'test-agent-data', data: { agentName: 'test-agent-data', targetUrl: 'http://example.com' } },
      ]);
      
      const result = await queueManager.getAgentStatus('test-agent-data');
      
      // Assert
      expect(result).not.toBeNull();
      expect(result?.name).toBe('test-agent-data');
    });
  });

  describe('removeAgent', () => {
    it('should remove repeatable and waiting/delayed jobs for agent', async () => {
      // Arrange: Create queue and add agent
      await queueManager.initialize();
      const agentConfig = {
        name: 'test-agent-remove',
        targetUrl: 'http://example.com',
        schedule: '0 */5 * * * *',
        queue: 'default',
      };
      
      await queueManager.addRecurringAgent(agentConfig);
      
      // Mock queue methods
      const queue = (queueManager as any).getOrCreateQueue('default');
      const mockJob = {
        id: 'job-1',
        name: 'test-agent-remove',
        remove: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      };
      (queue.getRepeatableJobs as any).mockResolvedValue([
        { id: 'agent:test-agent-remove', key: 'agent:test-agent-remove' },
      ]);
      (queue.getWaiting as any).mockResolvedValue([mockJob]);
      (queue.getDelayed as any).mockResolvedValue([]);
      
      // Mock checkAndCleanupEmptyQueue
      const checkAndCleanupSpy = jest.spyOn(queueManager as any, 'checkAndCleanupEmptyQueue').mockResolvedValue(undefined);
      
      // Act
      await queueManager.removeAgent('test-agent-remove');
      
      // Assert
      expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('agent:test-agent-remove');
      expect(mockJob.remove).toHaveBeenCalled();
      expect(checkAndCleanupSpy).toHaveBeenCalledWith('default');
      
      // Cleanup
      checkAndCleanupSpy.mockRestore();
    });

    it('should log error and return false when removeRepeatableByKey throws', async () => {
      // Arrange: Create queue and add agent
      await queueManager.initialize();
      const agentConfig = {
        name: 'test-agent-error',
        targetUrl: 'http://example.com',
        schedule: '0 */5 * * * *',
      };
      
      await queueManager.addRecurringAgent(agentConfig);
      
      // Mock queue methods - make removeRepeatableByKey throw
      const queue = (queueManager as any).getOrCreateQueue('default');
      (queue.getRepeatableJobs as any).mockResolvedValue([
        { id: 'agent:test-agent-error', key: 'agent:test-agent-error' },
      ]);
      (queue.getWaiting as any).mockResolvedValue([]);
      (queue.getDelayed as any).mockResolvedValue([]);
      (queue.removeRepeatableByKey as any).mockRejectedValue(new Error('Remove failed'));
      
      const loggerWarnSpy = jest.spyOn(logger, 'warn');
      const checkAndCleanupSpy = jest.spyOn(queueManager as any, 'checkAndCleanupEmptyQueue').mockResolvedValue(undefined);
      
      // Act
      await queueManager.removeAgent('test-agent-error');
      
      // Assert: Error logged but process continues
      expect(loggerWarnSpy).toHaveBeenCalled();
      expect(checkAndCleanupSpy).toHaveBeenCalled();
      
      // Cleanup
      loggerWarnSpy.mockRestore();
      checkAndCleanupSpy.mockRestore();
    });
  });

  describe('checkAndCleanupEmptyQueue', () => {
    it('should delete queue when it is empty', async () => {
      // Arrange: Non-default empty queue
      const queueName = 'empty-queue';
      const queue = (queueManager as any).getOrCreateQueue(queueName);
      
      // Mock queue to be empty
      (queue.getWaitingCount as any).mockResolvedValue(0);
      (queue.getActiveCount as any).mockResolvedValue(0);
      (queue.getDelayedCount as any).mockResolvedValue(0);
      (queue.getRepeatableJobs as any).mockResolvedValue([]);
      
      // Mock deleteQueue
      const deleteQueueSpy = jest.spyOn(queueManager, 'deleteQueue').mockResolvedValue(undefined);
      
      // Act
      await (queueManager as any).checkAndCleanupEmptyQueue(queueName);
      
      // Assert
      expect(deleteQueueSpy).toHaveBeenCalledWith(queueName);
      
      // Cleanup
      deleteQueueSpy.mockRestore();
    });

    it('should not delete queue when it is not empty', async () => {
      // Arrange: Queue with jobs
      const queueName = 'non-empty-queue';
      const queue = (queueManager as any).getOrCreateQueue(queueName);
      
      // Mock queue to have jobs
      (queue.getWaitingCount as any).mockResolvedValue(1);
      (queue.getActiveCount as any).mockResolvedValue(0);
      (queue.getDelayedCount as any).mockResolvedValue(0);
      (queue.getRepeatableJobs as any).mockResolvedValue([]);
      
      // Mock deleteQueue
      const deleteQueueSpy = jest.spyOn(queueManager, 'deleteQueue').mockResolvedValue(undefined);
      
      // Act
      await (queueManager as any).checkAndCleanupEmptyQueue(queueName);
      
      // Assert
      expect(deleteQueueSpy).not.toHaveBeenCalled();
      
      // Cleanup
      deleteQueueSpy.mockRestore();
    });

    it('should not delete default queue even when empty', async () => {
      // Arrange: Default queue (empty)
      const queueName = 'default';
      const queue = (queueManager as any).getOrCreateQueue(queueName);
      
      // Mock queue to be empty
      (queue.getWaitingCount as any).mockResolvedValue(0);
      (queue.getActiveCount as any).mockResolvedValue(0);
      (queue.getDelayedCount as any).mockResolvedValue(0);
      (queue.getRepeatableJobs as any).mockResolvedValue([]);
      
      // Mock deleteQueue
      const deleteQueueSpy = jest.spyOn(queueManager, 'deleteQueue').mockResolvedValue(undefined);
      
      // Act
      await (queueManager as any).checkAndCleanupEmptyQueue(queueName);
      
      // Assert: Default queue should not be deleted
      expect(deleteQueueSpy).not.toHaveBeenCalled();
      
      // Cleanup
      deleteQueueSpy.mockRestore();
    });

  });

  describe('findAgentQueue', () => {
    it('should find queue containing agent', async () => {
      // Arrange: Create queue and add agent
      await queueManager.initialize();
      const agentConfig = {
        name: 'test-agent-queue',
        targetUrl: 'http://example.com',
        schedule: '0 */5 * * * *',
        queue: 'default',
      };
      
      await queueManager.addRecurringAgent(agentConfig);
      
      // Mock getRepeatableJobs to return the agent job
      const queue = (queueManager as any).getOrCreateQueue('default');
      (queue.getRepeatableJobs as any).mockResolvedValue([
        { id: 'agent:test-agent-queue', key: 'agent:test-agent-queue', pattern: '0 */5 * * * *' },
      ]);
      
      // Act
      const result = await (queueManager as any).findAgentQueue('test-agent-queue');
      
      // Assert
      expect(result).not.toBeNull();
      expect(result?.queueName).toBe('default');
    });

    it('should return null when agent not in any queue', async () => {
      // Arrange: Initialize but don't add any agents
      await queueManager.initialize();
      
      // Act
      const result = await (queueManager as any).findAgentQueue('non-existent-agent');
      
      // Assert
      expect(result).toBeNull();
    });
  });

  describe('getOrCreateQueue', () => {
    it('should create new queue with correct concurrency settings', async () => {
      // Arrange: Queue name that doesn't exist
      const queueName = 'new-queue';
      const defaultConcurrency = parseInt(process.env.BULLMQ_CONCURRENCY || '5', 10);
      
      // Clear any existing mocks
      jest.clearAllMocks();
      
      // Act: Call getOrCreateQueue (private method, access via any)
      const queue = (queueManager as any).getOrCreateQueue(queueName);
      
      // Assert: Queue factory called with correct name
      expect(mockQueueFactory).toHaveBeenCalledWith(queueName, expect.objectContaining({
        connection: mockRedisInstance,
      }));
      
      // Assert: Worker factory called with default concurrency
      expect(mockWorkerFactory).toHaveBeenCalledWith(
        queueName,
        expect.any(Function),
        expect.objectContaining({
          connection: mockRedisInstance,
          concurrency: defaultConcurrency,
        })
      );
      
      // Assert: Queue events factory called
      expect(mockQueueEventsFactory).toHaveBeenCalledWith(queueName, expect.objectContaining({
        connection: mockRedisInstance,
      }));
      
      // Assert: Queue added to internal map and returned
      expect(queue).toBe(mockQueueInstance);
      expect(queueManager.getQueues()).toContain(queue);
    });

    it('should create task-operator queue with concurrency 1', async () => {
      // Arrange: task-operator queue name
      const queueName = 'task-operator';
      
      // Clear any existing mocks
      jest.clearAllMocks();
      
      // Act: Call getOrCreateQueue
      const queue = (queueManager as any).getOrCreateQueue(queueName);
      
      // Assert: Worker factory called with concurrency 1
      expect(mockWorkerFactory).toHaveBeenCalledWith(
        queueName,
        expect.any(Function),
        expect.objectContaining({
          connection: mockRedisInstance,
          concurrency: 1,
        })
      );
      
      // Assert: Other factories called correctly
      expect(mockQueueFactory).toHaveBeenCalled();
      expect(mockQueueEventsFactory).toHaveBeenCalled();
      expect(queue).toBe(mockQueueInstance);
    });

    it('should return existing queue without creating duplicates', async () => {
      // Arrange: Create queue first
      const queueName = 'existing-queue';
      const firstQueue = (queueManager as any).getOrCreateQueue(queueName);
      
      // Clear factory spies to track second call
      jest.clearAllMocks();
      
      // Act: Call getOrCreateQueue again
      const secondQueue = (queueManager as any).getOrCreateQueue(queueName);
      
      // Assert: Same queue instance returned
      expect(secondQueue).toBe(firstQueue);
      expect(secondQueue).toBe(mockQueueInstance);
      
      // Assert: Factories not called again (no duplicates)
      expect(mockQueueFactory).not.toHaveBeenCalled();
      expect(mockWorkerFactory).not.toHaveBeenCalled();
      expect(mockQueueEventsFactory).not.toHaveBeenCalled();
    });
  });

  describe('shutdown', () => {
    it('should shutdown gracefully', async () => {
      const options: RecurringPromptOptions = {
        name: 'test-prompt',
        prompt: 'Test prompt',
        schedule: '0 */5 * * * *',
      };

      await queueManager.initialize();
      await queueManager.addRecurringPrompt(options);
      await queueManager.shutdown();

      expect(mockWorkerInstance.close).toHaveBeenCalled();
      expect(mockQueueEventsInstance.close).toHaveBeenCalled();
      expect(mockQueueInstance.close).toHaveBeenCalled();
      expect(mockRedisInstance.quit).toHaveBeenCalled();
    });
  });
});
