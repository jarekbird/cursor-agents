import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { QueueManager, type QueueFactory, type WorkerFactory, type QueueEventsFactory } from '../../src/queue/queue-manager.js';
import type { AgentConfig, RecurringPromptOptions } from '../../src/queue/queue-manager.js';
import { Queue, Worker, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';

// Create mock instances
const mockQueueInstance = {
  add: jest.fn(),
  removeRepeatableByKey: jest.fn(),
  getRepeatableJobs: jest.fn(),
  getCompleted: jest.fn(),
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
      await queueManager.shutdown().catch(() => {
        // Ignore shutdown errors in tests
      });
    }
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
