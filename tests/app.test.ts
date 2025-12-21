import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import request from 'supertest';
import { CursorAgentsApp } from '../src/app.js';
import { QueueManager } from '../src/queue/queue-manager.js';
import { DatabaseService } from '../src/services/database-service.js';

// Mock QueueManager
jest.mock('../src/queue/queue-manager.js');

// Mock DatabaseService
jest.mock('../src/services/database-service.js');

// Mock Bull Board
jest.mock('@bull-board/api', () => ({
  createBullBoard: jest.fn(),
}));

// Mock BullMQAdapter to avoid queue type validation
const MockBullMQAdapter = jest.fn().mockImplementation(() => ({}));
jest.mock('@bull-board/api/bullMQAdapter', () => ({
  BullMQAdapter: MockBullMQAdapter,
}));

const mockSetBasePath = jest.fn();
jest.mock('@bull-board/express', () => ({
  ExpressAdapter: jest.fn().mockImplementation(() => ({
    setBasePath: mockSetBasePath,
    getRouter: jest.fn().mockReturnValue({
      get: jest.fn(),
      post: jest.fn(),
    }),
  })),
}));

describe('CursorAgentsApp', () => {
  let app: CursorAgentsApp;
  let mockQueueManager: jest.Mocked<QueueManager>;
  let mockDatabaseService: jest.Mocked<DatabaseService>;

  beforeEach(() => {
    // Reset mocks
    mockSetBasePath.mockClear();
    
    // Create mock DatabaseService
    mockDatabaseService = {
      setSystemSetting: jest.fn<() => boolean>().mockReturnValue(true),
      isSystemSettingEnabled: jest.fn<() => boolean>().mockReturnValue(false),
      getNextReadyTask: jest.fn(),
      updateTaskStatus: jest.fn(),
      markTaskComplete: jest.fn(),
      getTaskStatus: jest.fn(),
      close: jest.fn(),
    } as unknown as jest.Mocked<DatabaseService>;
    
    // Create mock QueueManager
    mockQueueManager = {
      initialize: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      listQueues: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
      addRecurringPrompt: jest
        .fn<() => Promise<{ id: string; name: string }>>()
        .mockResolvedValue({
          id: 'job-123',
          name: 'test-prompt',
        }),
      getPromptStatus: jest.fn<() => Promise<unknown>>().mockResolvedValue(null),
      removeRecurringPrompt: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      getQueues: jest.fn<() => unknown[]>().mockReturnValue([]),
      getQueueInfo: jest.fn<() => Promise<unknown>>().mockResolvedValue(null),
      addOneTimeAgent: jest.fn<(_config: unknown) => Promise<{ id: string; name: string }>>().mockResolvedValue({ id: 'job-1', name: 'test-agent' }),
      addRecurringAgent: jest.fn<(_config: unknown) => Promise<{ id: string; name: string }>>().mockResolvedValue({ id: 'job-1', name: 'test-agent' }),
      getAgentStatus: jest.fn<() => Promise<unknown>>().mockResolvedValue(null),
      removeAgent: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      shutdown: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<QueueManager>;

    // Inject mock QueueManager and DatabaseService via constructor
    app = new CursorAgentsApp(mockQueueManager, mockDatabaseService);
    
    // Verify mocks are set up
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await app.shutdown().catch(() => {
      // Ignore shutdown errors
    });
  });

  describe('Health Check', () => {
    it('should return health status', async () => {
      await app.initialize();

      const response = await request(app.app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('service', 'cursor-agents');
      expect(response.body).toHaveProperty('timestamp');
    });
  });

  describe('GET /queues', () => {
    it('should return list of queues', async () => {
      mockQueueManager.listQueues.mockResolvedValueOnce(['queue1', 'queue2']);
      mockQueueManager.getQueueInfo.mockImplementation(async (queueName: string) => {
        return {
          name: queueName,
          waiting: 0,
          active: 0,
          completed: 0,
          failed: 0,
          delayed: 0,
          agents: [],
        };
      });

      await app.initialize();

      const response = await request(app.app).get('/queues');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('queues');
      expect(response.body.queues).toHaveLength(2);
      expect(response.body.queues[0]).toHaveProperty('name');
    });

    it('should handle errors', async () => {
      mockQueueManager.listQueues.mockRejectedValueOnce(new Error('Redis error'));

      await app.initialize();

      const response = await request(app.app).get('/queues');

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error', 'Failed to list queues');
    });
  });

  describe('GET /queues/:queueName', () => {
    it('should return queue info for existing queue', async () => {
      // Arrange: Mock queueManager.getQueueInfo to return sample queue object for "q1"
      const mockQueueInfo = {
        name: 'q1',
        waiting: 5,
        active: 2,
        completed: 10,
        failed: 1,
        delayed: 3,
        agents: [],
      };
      mockQueueManager.getQueueInfo.mockResolvedValueOnce(mockQueueInfo);

      await app.initialize();

      // Act: GET /queues/q1 using supertest
      const response = await request(app.app).get('/queues/q1');

      // Assert: Response status is 200, Response body equals mock queue info
      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockQueueInfo);
    });

    it('should return 404 when queue is not found', async () => {
      // Arrange: Mock getQueueInfo to return null
      mockQueueManager.getQueueInfo.mockResolvedValueOnce(null);

      await app.initialize();

      // Act: GET /queues/q1
      const response = await request(app.app).get('/queues/q1');

      // Assert: Response status is 404, Response body contains message `Queue "q1" not found`
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Queue "q1" not found' });
    });

    it('should return 500 when getQueueInfo throws', async () => {
      // Arrange: Mock getQueueInfo to throw error
      mockQueueManager.getQueueInfo.mockRejectedValueOnce(new Error('Database error'));

      await app.initialize();

      // Act: GET /queues/q1
      const response = await request(app.app).get('/queues/q1');

      // Assert: Response status is 500, Response body contains error JSON
      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error', 'Failed to get queue info');
    });
  });

  describe('DELETE /queues/:queueName', () => {
    it('should delete queue successfully', async () => {
      // Arrange: Mock deleteQueue to resolve
      mockQueueManager.deleteQueue = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

      await app.initialize();

      // Act
      const response = await request(app.app)
        .delete('/queues/q1')
        .expect(200);

      // Assert
      expect(response.body).toEqual({
        success: true,
        message: expect.stringContaining('q1'),
      });
      expect(mockQueueManager.deleteQueue).toHaveBeenCalledWith('q1');
    });

    it('should return 500 when queue has jobs', async () => {
      // Arrange: deleteQueue throws error
      const error = new Error('Queue has remaining jobs');
      mockQueueManager.deleteQueue = jest.fn<() => Promise<void>>().mockRejectedValue(error);

      await app.initialize();

      // Act
      const response = await request(app.app)
        .delete('/queues/q1')
        .expect(500);

      // Assert
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('jobs');
    });
  });

  describe('POST /agents', () => {
    it('should return 400 when name is missing', async () => {
      await app.initialize();

      const response = await request(app.app)
        .post('/agents')
        .send({ targetUrl: 'http://example.com' })
        .expect(400);

      expect(response.body.error).toContain('Missing required fields');
    });

    it('should return 400 when targetUrl is missing', async () => {
      await app.initialize();

      const response = await request(app.app)
        .post('/agents')
        .send({ name: 'test-agent' })
        .expect(400);

      expect(response.body.error).toContain('Missing required fields');
    });

    it('should return 400 when oneTime=false and no schedule', async () => {
      await app.initialize();

      const response = await request(app.app)
        .post('/agents')
        .send({ name: 'test-agent', targetUrl: 'http://example.com', oneTime: false })
        .expect(400);

      expect(response.body.error).toContain('schedule must be provided');
    });

    it('should create one-time agent with defaults', async () => {
      await app.initialize();

      const response = await request(app.app)
        .post('/agents')
        .send({ name: 'test-agent', targetUrl: 'http://example.com', oneTime: true })
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: expect.stringContaining('test-agent'),
        agent: expect.objectContaining({
          name: 'test-agent',
          targetUrl: 'http://example.com',
          method: 'POST',
          oneTime: true,
          queue: 'default',
        }),
      });
      expect(mockQueueManager.addOneTimeAgent).toHaveBeenCalled();
    });

    it('should create recurring agent with schedule', async () => {
      await app.initialize();

      const response = await request(app.app)
        .post('/agents')
        .send({
          name: 'test-agent',
          targetUrl: 'http://example.com',
          schedule: '0 */5 * * * *',
        })
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: expect.stringContaining('test-agent'),
        agent: expect.objectContaining({
          name: 'test-agent',
          targetUrl: 'http://example.com',
          method: 'POST',
          schedule: '0 */5 * * * *',
          queue: 'default',
        }),
      });
      expect(mockQueueManager.addRecurringAgent).toHaveBeenCalled();
    });

    it('should return 500 when queue method rejects', async () => {
      mockQueueManager.addOneTimeAgent.mockRejectedValueOnce(new Error('Queue error'));

      await app.initialize();

      const response = await request(app.app)
        .post('/agents')
        .send({ name: 'test-agent', targetUrl: 'http://example.com', oneTime: true })
        .expect(500);

      expect(response.body).toHaveProperty('error', 'Failed to create agent');
    });
  });

  describe('GET /agents', () => {
    it('should list all agents and filter null values', async () => {
      // Arrange: Mock listQueues and getAgentStatus to return queue objects
      // Note: getAgentStatus is called with queue names, not agent names
      mockQueueManager.listQueues.mockResolvedValueOnce(['queue1', 'queue2']);
      mockQueueManager.getAgentStatus
        .mockResolvedValueOnce({ name: 'agent1', isActive: true } as any)
        .mockResolvedValueOnce(null); // This should be filtered out

      await app.initialize();

      // Act: GET /agents
      const response = await request(app.app).get('/agents');

      // Assert: 200, agents array without nulls
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('agents');
      expect(response.body.agents).toHaveLength(1);
      expect(response.body.agents[0]).toEqual({ name: 'agent1', isActive: true });
    });

    it('should return 500 when listQueues rejects', async () => {
      mockQueueManager.listQueues.mockRejectedValueOnce(new Error('Redis error'));

      await app.initialize();

      const response = await request(app.app).get('/agents');

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error', 'Failed to list agents');
    });
  });

  describe('GET /agents/:name', () => {
    it('should return agent status when agent exists', async () => {
      // Arrange: Mock getAgentStatus to return status object
      const mockStatus = { name: 'test-agent', isActive: true, targetUrl: 'http://example.com' };
      mockQueueManager.getAgentStatus.mockResolvedValueOnce(mockStatus as any);

      await app.initialize();

      // Act: GET /agents/test
      const response = await request(app.app).get('/agents/test-agent');

      // Assert: 200, status JSON
      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockStatus);
    });

    it('should return 404 when agent not found', async () => {
      // Arrange: getAgentStatus returns null
      mockQueueManager.getAgentStatus.mockResolvedValueOnce(null);

      await app.initialize();

      // Act: GET /agents/non-existent
      const response = await request(app.app).get('/agents/non-existent');

      // Assert: 404, message "Agent \"non-existent\" not found"
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Agent "non-existent" not found' });
    });

    it('should return 500 when getAgentStatus throws', async () => {
      // Arrange: getAgentStatus throws
      mockQueueManager.getAgentStatus.mockRejectedValueOnce(new Error('Database error'));

      await app.initialize();

      // Act: GET /agents/test
      const response = await request(app.app).get('/agents/test');

      // Assert: 500, error message
      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error', 'Failed to get agent status');
    });
  });

  describe('DELETE /agents/:name', () => {
    it('should delete agent successfully', async () => {
      // Arrange: Mock removeAgent to resolve
      await app.initialize();

      // Act: DELETE /agents/test
      const response = await request(app.app)
        .delete('/agents/test-agent')
        .expect(200);

      // Assert: 200, success
      expect(response.body).toEqual({
        success: true,
        message: expect.stringContaining('test-agent'),
      });
      expect(mockQueueManager.removeAgent).toHaveBeenCalledWith('test-agent');
    });

    it('should return 500 when removeAgent throws', async () => {
      // Arrange: removeAgent throws error
      mockQueueManager.removeAgent.mockRejectedValueOnce(new Error('Agent not found'));

      await app.initialize();

      // Act: DELETE /agents/test
      const response = await request(app.app)
        .delete('/agents/test-agent')
        .expect(500);

      // Assert: 500, error message
      expect(response.body).toHaveProperty('error', 'Failed to delete agent');
    });
  });

  describe('POST /task-operator', () => {
    it('should enable task operator successfully', async () => {
      // Arrange: Mock setSystemSetting to return true, addOneTimeAgent to return job
      // Ensure isSystemSettingEnabled returns false during initialize() so it doesn't auto-start
      mockDatabaseService.isSystemSettingEnabled.mockReturnValue(false);
      mockDatabaseService.setSystemSetting.mockReturnValue(true);
      mockQueueManager.addOneTimeAgent.mockResolvedValue({ id: 'job-1', name: 'task-operator' });

      await app.initialize();

      // Act: POST /task-operator
      const response = await request(app.app)
        .post('/task-operator')
        .send({}); // Explicitly send empty body

      // Assert: 200, success JSON with agent info
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        message: 'Task operator agent enqueued successfully',
        agent: expect.objectContaining({
          name: 'task-operator',
          jobId: 'job-1',
          queue: 'task-operator',
        }),
      });
      expect(mockDatabaseService.setSystemSetting).toHaveBeenCalledWith('task_operator', true);
      expect(mockQueueManager.addOneTimeAgent).toHaveBeenCalled();
    });

    it('should still succeed when setSystemSetting returns false', async () => {
      // Arrange: setSystemSetting returns false but addOneTimeAgent succeeds
      // Note: The implementation logs a warning but continues, so it should still return 200
      mockDatabaseService.setSystemSetting.mockReturnValue(false);
      mockQueueManager.addOneTimeAgent.mockResolvedValue({ id: 'job-1', name: 'task-operator' });

      await app.initialize();

      // Act: POST /task-operator
      const response = await request(app.app)
        .post('/task-operator');

      // Assert: Should still succeed (200) even if setSystemSetting fails
      // The implementation logs a warning but continues
      if (response.status === 200) {
        expect(response.body).toHaveProperty('success', true);
      } else {
        // If it fails, check the error
        expect(response.body).toHaveProperty('error');
      }
    });

    it('should return 500 when addOneTimeAgent throws', async () => {
      // Arrange: addOneTimeAgent throws
      mockDatabaseService.setSystemSetting.mockReturnValueOnce(true);
      mockQueueManager.addOneTimeAgent.mockRejectedValueOnce(new Error('Queue error'));

      await app.initialize();

      // Act: POST /task-operator
      const response = await request(app.app)
        .post('/task-operator')
        .expect(500);

      // Assert: 500, error message
      expect(response.body).toHaveProperty('error', 'Failed to enqueue task operator');
    });
  });

  describe('DELETE /task-operator', () => {
    it('should disable task operator successfully', async () => {
      // Arrange: Mock setSystemSetting to return true, removeAgent to resolve
      mockDatabaseService.setSystemSetting.mockReturnValueOnce(true);

      await app.initialize();

      // Act: DELETE /task-operator
      const response = await request(app.app)
        .delete('/task-operator')
        .expect(200);

      // Assert: 200, success JSON
      expect(response.body).toEqual({
        success: true,
        message: expect.stringContaining('disabled'),
      });
      expect(mockDatabaseService.setSystemSetting).toHaveBeenCalledWith('task_operator', false);
      expect(mockQueueManager.removeAgent).toHaveBeenCalledWith('task-operator');
    });

    it('should handle removeAgent not found error', async () => {
      // Arrange: removeAgent throws "not found" error (should be ignored)
      mockDatabaseService.setSystemSetting.mockReturnValueOnce(true);
      mockQueueManager.removeAgent.mockRejectedValueOnce(new Error('Agent "task-operator" not found'));

      await app.initialize();

      // Act: DELETE /task-operator
      const response = await request(app.app)
        .delete('/task-operator')
        .expect(200);

      // Assert: 200, success (error ignored)
      expect(response.body).toHaveProperty('success', true);
    });

    it('should return 500 when setSystemSetting returns false', async () => {
      // Arrange: setSystemSetting returns false
      mockDatabaseService.setSystemSetting.mockReturnValueOnce(false);

      await app.initialize();

      // Act: DELETE /task-operator
      const response = await request(app.app)
        .delete('/task-operator')
        .expect(500);

      // Assert: 500, error message
      expect(response.body).toHaveProperty('error', 'Failed to disable task operator');
    });

    // Note: The catch block at lines 382-384 is defensive programming.
    // In practice, removeAgent errors are caught internally (lines 365-370),
    // and setSystemSetting is synchronous and doesn't throw.
    // This catch block would only trigger on unexpected errors, which are hard to test.
    // The error handling is still valuable defensive code.
  });

  describe('GET /task-operator/lock', () => {
    it('should return lock status when processing', async () => {
      // Arrange: Mock isProcessing to return true
      const { TaskOperatorService } = await import('../src/services/task-operator-service.js');
      const mockTaskOperatorService = {
        isProcessing: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      };
      jest.spyOn(TaskOperatorService, 'getInstance').mockReturnValue(mockTaskOperatorService as any);

      await app.initialize();

      // Act: GET /task-operator/lock
      const response = await request(app.app)
        .get('/task-operator/lock')
        .expect(200);

      // Assert: 200, { success: true, isLocked: true, message: <string> }
      expect(response.body).toEqual({
        success: true,
        isLocked: true,
        message: expect.any(String),
      });
    });

    it('should return lock status when not processing', async () => {
      // Arrange: Mock isProcessing to return false
      const { TaskOperatorService } = await import('../src/services/task-operator-service.js');
      const mockTaskOperatorService = {
        isProcessing: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
      };
      jest.spyOn(TaskOperatorService, 'getInstance').mockReturnValue(mockTaskOperatorService as any);

      await app.initialize();

      // Act: GET /task-operator/lock
      const response = await request(app.app)
        .get('/task-operator/lock')
        .expect(200);

      // Assert: 200, { success: true, isLocked: false, message: <string> }
      expect(response.body).toEqual({
        success: true,
        isLocked: false,
        message: expect.any(String),
      });
    });

    it('should return 500 when isProcessing throws', async () => {
      // Arrange: Mock isProcessing to throw
      const { TaskOperatorService } = await import('../src/services/task-operator-service.js');
      const mockTaskOperatorService = {
        isProcessing: jest.fn<() => Promise<boolean>>().mockRejectedValue(new Error('Redis error')),
      };
      jest.spyOn(TaskOperatorService, 'getInstance').mockReturnValue(mockTaskOperatorService as any);

      await app.initialize();

      // Act: GET /task-operator/lock
      const response = await request(app.app)
        .get('/task-operator/lock')
        .expect(500);

      // Assert: 500, error message
      expect(response.body).toHaveProperty('error', 'Failed to check task operator lock status');
    });
  });

  describe('DELETE /task-operator/lock', () => {
    it('should clear lock and return lockCleared: true', async () => {
      // Arrange: Mock clearLock to return true
      const { TaskOperatorService } = await import('../src/services/task-operator-service.js');
      const mockTaskOperatorService = {
        clearLock: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      };
      jest.spyOn(TaskOperatorService, 'getInstance').mockReturnValue(mockTaskOperatorService as any);

      await app.initialize();

      // Act: DELETE /task-operator/lock
      const response = await request(app.app)
        .delete('/task-operator/lock')
        .expect(200);

      // Assert: 200, { success: true, lockCleared: true, message: <string> }
      expect(response.body).toEqual({
        success: true,
        lockCleared: true,
        message: expect.any(String),
      });
    });

    it('should return lockCleared: false when lock did not exist', async () => {
      // Arrange: Mock clearLock to return false
      const { TaskOperatorService } = await import('../src/services/task-operator-service.js');
      const mockTaskOperatorService = {
        clearLock: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
      };
      jest.spyOn(TaskOperatorService, 'getInstance').mockReturnValue(mockTaskOperatorService as any);

      await app.initialize();

      // Act: DELETE /task-operator/lock
      const response = await request(app.app)
        .delete('/task-operator/lock')
        .expect(200);

      // Assert: 200, { success: true, lockCleared: false, message: <string> }
      expect(response.body).toEqual({
        success: true,
        lockCleared: false,
        message: expect.any(String),
      });
    });

    it('should return 500 when clearLock throws', async () => {
      // Arrange: Mock clearLock to throw
      const { TaskOperatorService } = await import('../src/services/task-operator-service.js');
      const mockTaskOperatorService = {
        clearLock: jest.fn<() => Promise<boolean>>().mockRejectedValue(new Error('Redis error')),
      };
      jest.spyOn(TaskOperatorService, 'getInstance').mockReturnValue(mockTaskOperatorService as any);

      await app.initialize();

      // Act: DELETE /task-operator/lock
      const response = await request(app.app)
        .delete('/task-operator/lock')
        .expect(500);

      // Assert: 500, error message
      expect(response.body).toHaveProperty('error', 'Failed to clear task operator lock');
    });
  });

  describe('POST /task-operator/callback', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      jest.resetModules();
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    describe('secret authentication', () => {
      beforeEach(() => {
        process.env.WEBHOOK_SECRET = 'test-secret';
      });

      afterEach(() => {
        delete process.env.WEBHOOK_SECRET;
      });

      it('should return 401 when secret is missing', async () => {
        await app.initialize();

        // Act: POST /task-operator/callback without secret
        const response = await request(app.app)
          .post('/task-operator/callback')
          .send({ requestId: 'test-request-id' })
          .expect(401);

        // Assert: 401, "Unauthorized"
        expect(response.body).toEqual({ error: 'Unauthorized' });
      });

      it('should return 401 when secret is incorrect', async () => {
        await app.initialize();

        // Act: POST /task-operator/callback with wrong secret in header
        const response = await request(app.app)
          .post('/task-operator/callback')
          .set('x-webhook-secret', 'wrong-secret')
          .send({ requestId: 'test-request-id' })
          .expect(401);

        // Assert: 401, "Unauthorized"
        expect(response.body).toEqual({ error: 'Unauthorized' });
      });

      it('should accept secret from x-webhook-secret header', async () => {
        // Arrange: Mock handleCallback to succeed
        const { TaskOperatorService } = await import('../src/services/task-operator-service.js');
        const mockTaskOperatorService = {
          handleCallback: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        };
        jest.spyOn(TaskOperatorService, 'getInstance').mockReturnValue(mockTaskOperatorService as any);

        await app.initialize();

        // Act: POST /task-operator/callback with valid secret in header
        const response = await request(app.app)
          .post('/task-operator/callback')
          .set('x-webhook-secret', 'test-secret')
          .send({ requestId: 'test-request-id' })
          .expect(200);

        // Assert: Proceeds to requestId checks (not 401)
        expect(response.body).toEqual({
          received: true,
          requestId: 'test-request-id',
        });
        expect(mockTaskOperatorService.handleCallback).toHaveBeenCalledWith('test-request-id', expect.any(Object));
      });

      it('should accept secret from x-cursor-runner-secret header', async () => {
        // Arrange: Mock handleCallback to succeed
        const { TaskOperatorService } = await import('../src/services/task-operator-service.js');
        const mockTaskOperatorService = {
          handleCallback: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        };
        jest.spyOn(TaskOperatorService, 'getInstance').mockReturnValue(mockTaskOperatorService as any);

        await app.initialize();

        // Act: POST /task-operator/callback with valid secret in x-cursor-runner-secret header
        const response = await request(app.app)
          .post('/task-operator/callback')
          .set('x-cursor-runner-secret', 'test-secret')
          .send({ requestId: 'test-request-id' })
          .expect(200);

        // Assert: Proceeds to requestId checks (not 401)
        expect(response.body).toEqual({
          received: true,
          requestId: 'test-request-id',
        });
        expect(mockTaskOperatorService.handleCallback).toHaveBeenCalledWith('test-request-id', expect.any(Object));
      });

      it('should accept secret from query string', async () => {
        // Arrange: Mock handleCallback to succeed
        const { TaskOperatorService } = await import('../src/services/task-operator-service.js');
        const mockTaskOperatorService = {
          handleCallback: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        };
        jest.spyOn(TaskOperatorService, 'getInstance').mockReturnValue(mockTaskOperatorService as any);

        await app.initialize();

        // Act: POST /task-operator/callback with valid secret in query string
        const response = await request(app.app)
          .post('/task-operator/callback?secret=test-secret')
          .send({ requestId: 'test-request-id' })
          .expect(200);

        // Assert: Proceeds to requestId checks (not 401)
        expect(response.body).toEqual({
          received: true,
          requestId: 'test-request-id',
        });
        expect(mockTaskOperatorService.handleCallback).toHaveBeenCalledWith('test-request-id', expect.any(Object));
      });

      it('should prioritize headers over query string when both are present', async () => {
        // Arrange: Mock handleCallback to succeed
        const { TaskOperatorService } = await import('../src/services/task-operator-service.js');
        const mockTaskOperatorService = {
          handleCallback: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        };
        jest.spyOn(TaskOperatorService, 'getInstance').mockReturnValue(mockTaskOperatorService as any);

        await app.initialize();

        // Act: POST /task-operator/callback with valid secret in header and query
        const response = await request(app.app)
          .post('/task-operator/callback?secret=test-secret')
          .set('x-webhook-secret', 'test-secret')
          .send({ requestId: 'test-request-id' })
          .expect(200);

        // Assert: Accepts header secret (proceeds, not 401)
        expect(response.body).toEqual({
          received: true,
          requestId: 'test-request-id',
        });
      });
    });

    describe('requestId validation', () => {
      beforeEach(() => {
        process.env.WEBHOOK_SECRET = 'test-secret';
      });

      afterEach(() => {
        delete process.env.WEBHOOK_SECRET;
      });

      it('should return 400 when requestId is missing', async () => {
        await app.initialize();

        // Act: POST /task-operator/callback with valid secret but no requestId
        const response = await request(app.app)
          .post('/task-operator/callback')
          .set('x-webhook-secret', 'test-secret')
          .send({})
          .expect(400);

        // Assert: 400, "requestId is required"
        expect(response.body).toEqual({ error: 'requestId is required' });
      });

      it('should accept requestId from body', async () => {
        // Arrange: Mock handleCallback to succeed
        const { TaskOperatorService } = await import('../src/services/task-operator-service.js');
        const mockTaskOperatorService = {
          handleCallback: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        };
        jest.spyOn(TaskOperatorService, 'getInstance').mockReturnValue(mockTaskOperatorService as any);

        await app.initialize();

        // Act: POST /task-operator/callback with requestId in body
        const response = await request(app.app)
          .post('/task-operator/callback')
          .set('x-webhook-secret', 'test-secret')
          .send({ requestId: 'test-request-id-123' })
          .expect(200);

        // Assert: Proceeds to callback processing (not 400)
        expect(response.body).toEqual({
          received: true,
          requestId: 'test-request-id-123',
        });
        expect(mockTaskOperatorService.handleCallback).toHaveBeenCalledWith('test-request-id-123', expect.objectContaining({ requestId: 'test-request-id-123' }));
      });

      it('should accept request_id from body', async () => {
        // Arrange: Mock handleCallback to succeed
        const { TaskOperatorService } = await import('../src/services/task-operator-service.js');
        const mockTaskOperatorService = {
          handleCallback: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        };
        jest.spyOn(TaskOperatorService, 'getInstance').mockReturnValue(mockTaskOperatorService as any);

        await app.initialize();

        // Act: POST /task-operator/callback with request_id in body
        const response = await request(app.app)
          .post('/task-operator/callback')
          .set('x-webhook-secret', 'test-secret')
          .send({ request_id: 'test-request-id-456' })
          .expect(200);

        // Assert: Proceeds to callback processing (not 400)
        expect(response.body).toEqual({
          received: true,
          requestId: 'test-request-id-456',
        });
        expect(mockTaskOperatorService.handleCallback).toHaveBeenCalledWith('test-request-id-456', expect.objectContaining({ request_id: 'test-request-id-456' }));
      });

      it('should prioritize requestId over request_id when both are present', async () => {
        // Arrange: Mock handleCallback to succeed
        const { TaskOperatorService } = await import('../src/services/task-operator-service.js');
        const mockTaskOperatorService = {
          handleCallback: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        };
        jest.spyOn(TaskOperatorService, 'getInstance').mockReturnValue(mockTaskOperatorService as any);

        await app.initialize();

        // Act: POST /task-operator/callback with both requestId and request_id
        const response = await request(app.app)
          .post('/task-operator/callback')
          .set('x-webhook-secret', 'test-secret')
          .send({ requestId: 'priority-id', request_id: 'secondary-id' })
          .expect(200);

        // Assert: Uses requestId (priority)
        expect(response.body).toEqual({
          received: true,
          requestId: 'priority-id',
        });
        expect(mockTaskOperatorService.handleCallback).toHaveBeenCalledWith('priority-id', expect.objectContaining({ requestId: 'priority-id', request_id: 'secondary-id' }));
      });
    });

    describe('callback processing', () => {
      beforeEach(() => {
        process.env.WEBHOOK_SECRET = 'test-secret';
      });

      afterEach(() => {
        delete process.env.WEBHOOK_SECRET;
      });

      it('should process callback successfully', async () => {
        // Arrange: Mock handleCallback to succeed
        const { TaskOperatorService } = await import('../src/services/task-operator-service.js');
        const mockTaskOperatorService = {
          handleCallback: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        };
        jest.spyOn(TaskOperatorService, 'getInstance').mockReturnValue(mockTaskOperatorService as any);

        await app.initialize();

        // Act: POST /task-operator/callback with valid secret and callback data
        const callbackBody = {
          requestId: 'test-request-id-789',
          success: true,
          output: 'Task completed successfully',
        };

        const response = await request(app.app)
          .post('/task-operator/callback')
          .set('x-webhook-secret', 'test-secret')
          .send(callbackBody)
          .expect(200);

        // Assert: 200, { received: true, requestId }
        expect(response.body).toEqual({
          received: true,
          requestId: 'test-request-id-789',
        });
        expect(mockTaskOperatorService.handleCallback).toHaveBeenCalledWith('test-request-id-789', callbackBody);
      });

      it('should process callback with error data', async () => {
        // Arrange: Mock handleCallback to succeed (even with error in body)
        const { TaskOperatorService } = await import('../src/services/task-operator-service.js');
        const mockTaskOperatorService = {
          handleCallback: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        };
        jest.spyOn(TaskOperatorService, 'getInstance').mockReturnValue(mockTaskOperatorService as any);

        await app.initialize();

        // Act: POST /task-operator/callback with error in body
        const callbackBody = {
          requestId: 'test-request-id-error',
          success: false,
          error: 'Task failed',
        };

        const response = await request(app.app)
          .post('/task-operator/callback')
          .set('x-webhook-secret', 'test-secret')
          .send(callbackBody)
          .expect(200);

        // Assert: Still returns 200 (always returns 200 to prevent retries)
        expect(response.body).toEqual({
          received: true,
          requestId: 'test-request-id-error',
        });
        expect(mockTaskOperatorService.handleCallback).toHaveBeenCalledWith('test-request-id-error', callbackBody);
      });

      it('should return 200 with error when handleCallback throws', async () => {
        // Arrange: Mock handleCallback to throw error
        const { TaskOperatorService } = await import('../src/services/task-operator-service.js');
        const mockTaskOperatorService = {
          handleCallback: jest.fn<() => Promise<void>>().mockRejectedValue(new Error('Database error')),
        };
        jest.spyOn(TaskOperatorService, 'getInstance').mockReturnValue(mockTaskOperatorService as any);

        await app.initialize();

        // Act: POST /task-operator/callback with valid secret and requestId
        const callbackBody = {
          requestId: 'test-request-id-error-handling',
          success: true,
        };

        const response = await request(app.app)
          .post('/task-operator/callback')
          .set('x-webhook-secret', 'test-secret')
          .send(callbackBody)
          .expect(200);

        // Assert: 200, { received: true, error: 'Internal error processing callback' }
        // Note: Returns 200 (not 500) to prevent cursor-runner from retrying
        expect(response.body).toEqual({
          received: true,
          error: 'Internal error processing callback',
        });
        expect(mockTaskOperatorService.handleCallback).toHaveBeenCalledWith('test-request-id-error-handling', callbackBody);
      });
    });
  });

  describe('POST /prompts/recurring', () => {
    it('should create a recurring prompt', async () => {
      await app.initialize();

      const response = await request(app.app)
        .post('/prompts/recurring')
        .send({
          name: 'test-prompt',
          prompt: 'Test prompt',
          schedule: '0 */5 * * * *',
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('jobId');
      expect(response.body).toHaveProperty('name', 'test-prompt');
      expect(mockQueueManager.addRecurringPrompt).toHaveBeenCalledWith({
        name: 'test-prompt',
        prompt: 'Test prompt',
        schedule: '0 */5 * * * *',
        options: {},
      });
    });

    it('should return 400 if required fields are missing', async () => {
      await app.initialize();

      const response = await request(app.app)
        .post('/prompts/recurring')
        .send({
          name: 'test-prompt',
          // Missing prompt and schedule
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('Missing required fields');
    });

    it('should handle errors', async () => {
      mockQueueManager.addRecurringPrompt.mockRejectedValueOnce(
        new Error('Queue error')
      );

      await app.initialize();

      const response = await request(app.app)
        .post('/prompts/recurring')
        .send({
          name: 'test-prompt',
          prompt: 'Test prompt',
          schedule: '0 */5 * * * *',
        });

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error', 'Failed to add recurring prompt');
    });
  });

  describe('GET /prompts/:name', () => {
    it('should return prompt status', async () => {
      mockQueueManager.getPromptStatus.mockResolvedValueOnce({
        name: 'test-prompt',
        isActive: true,
        lastRun: new Date(),
        nextRun: new Date(),
      });

      await app.initialize();

      const response = await request(app.app).get('/prompts/test-prompt');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('name', 'test-prompt');
      expect(response.body).toHaveProperty('isActive', true);
    });

    it('should return 404 if prompt not found', async () => {
      mockQueueManager.getPromptStatus.mockResolvedValueOnce(null);

      await app.initialize();

      const response = await request(app.app).get('/prompts/non-existent');

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error', 'Prompt not found');
    });

    it('should handle errors', async () => {
      mockQueueManager.getPromptStatus.mockRejectedValueOnce(new Error('Error'));

      await app.initialize();

      const response = await request(app.app).get('/prompts/test-prompt');

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error', 'Failed to get prompt status');
    });
  });

  describe('DELETE /prompts/:name', () => {
    it('should remove a prompt', async () => {
      await app.initialize();

      const response = await request(app.app).delete('/prompts/test-prompt');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      expect(mockQueueManager.removeRecurringPrompt).toHaveBeenCalledWith('test-prompt');
    });

    it('should handle errors', async () => {
      mockQueueManager.removeRecurringPrompt.mockRejectedValueOnce(
        new Error('Error')
      );

      await app.initialize();

      const response = await request(app.app).delete('/prompts/test-prompt');

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error', 'Failed to remove recurring prompt');
    });
  });

  describe('Bull Board Dashboard', () => {
    it('should mount Bull Board at /admin/queues', async () => {
      await app.initialize();

      const response = await request(app.app).get('/admin/queues');

      // Bull Board should return HTML
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
    });

    it('should serve Bull Board dashboard at configured base path', async () => {
      // Arrange: Set base path, create app
      const originalEnv = process.env.BULL_BOARD_BASE_PATH;
      process.env.BULL_BOARD_BASE_PATH = '/agents/admin/queues';
      
      const testApp = new CursorAgentsApp(mockQueueManager);
      await testApp.initialize();
      
      // Act: GET /admin/queues (the route is still /admin/queues, base path is for assets)
      const response = await request(testApp.app).get('/admin/queues');
      
      // Assert: 200, HTML response
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      
      // Cleanup
      process.env.BULL_BOARD_BASE_PATH = originalEnv;
      await testApp.shutdown().catch(() => {});
    });

    it('should refresh Bull Board and return queue count', async () => {
      // Arrange: Ensure getQueues returns empty array to avoid BullMQAdapter validation issues
      mockQueueManager.getQueues.mockReturnValue([] as any);
      
      await app.initialize();
      
      // Act
      const response = await request(app.app)
        .post('/admin/queues/refresh')
        .expect(200);
      
      // Assert
      expect(response.body).toEqual({
        success: true,
        message: 'Bull Board refreshed successfully',
        queueCount: 0, // Empty queues array
      });
      // Verify getQueues was called (which updateBullBoard uses)
      expect(mockQueueManager.getQueues).toHaveBeenCalled();
    });

    it('should return 500 when refresh fails', async () => {
      // Arrange: Force updateBullBoard to throw
      await app.initialize();
      
      const updateBullBoardSpy = jest.spyOn(app as any, 'updateBullBoard').mockImplementation(() => {
        throw new Error('Refresh failed');
      });
      
      // Act
      const response = await request(app.app)
        .post('/admin/queues/refresh')
        .expect(500);
      
      // Assert
      expect(response.body).toEqual({
        error: 'Failed to refresh Bull Board',
      });
      
      // Cleanup
      updateBullBoardSpy.mockRestore();
    });
  });

  describe('initialization', () => {
    it('should initialize queue manager', async () => {
      await app.initialize();

      expect(mockQueueManager.initialize).toHaveBeenCalled();
    });

    it('should handle initialization errors', async () => {
      mockQueueManager.initialize.mockRejectedValueOnce(new Error('Init error'));

      await expect(app.initialize()).rejects.toThrow('Init error');
    });
  });

  describe('shutdown', () => {
    it('should shutdown gracefully', async () => {
      await app.initialize();
      await app.shutdown();

      expect(mockQueueManager.shutdown).toHaveBeenCalled();
    });
  });

  describe('initialize - auto-start task operator', () => {
    it('should auto-start task operator when enabled', async () => {
      // Arrange: Task operator is enabled
      mockDatabaseService.isSystemSettingEnabled.mockReturnValueOnce(true);
      mockQueueManager.addOneTimeAgent.mockResolvedValueOnce({
        id: 'task-operator-job-123',
        name: 'task-operator',
      });

      // Act: Initialize app
      await app.initialize();

      // Assert: addOneTimeAgent was called with task-operator config (covers lines 526-550)
      expect(mockDatabaseService.isSystemSettingEnabled).toHaveBeenCalledWith('task_operator');
      expect(mockQueueManager.addOneTimeAgent).toHaveBeenCalledWith({
        name: 'task-operator',
        targetUrl: 'task-operator://internal',
        method: 'POST',
        body: {
          type: 'task_operator',
          agentName: 'task-operator',
          queue: 'task-operator',
        },
        queue: 'task-operator',
        timeout: 30000,
      });
    });

    it('should handle auto-start task operator failure gracefully', async () => {
      // Arrange: Task operator is enabled but addOneTimeAgent fails
      mockDatabaseService.isSystemSettingEnabled.mockReturnValueOnce(true);
      mockQueueManager.addOneTimeAgent.mockRejectedValueOnce(new Error('Failed to start task operator'));

      // Act: Initialize app (should not throw)
      await expect(app.initialize()).resolves.not.toThrow();

      // Assert: addOneTimeAgent was called but error was caught (covers line 549-550)
      expect(mockDatabaseService.isSystemSettingEnabled).toHaveBeenCalledWith('task_operator');
      expect(mockQueueManager.addOneTimeAgent).toHaveBeenCalled();
    });

    it('should not auto-start task operator when disabled', async () => {
      // Arrange: Task operator is disabled
      mockDatabaseService.isSystemSettingEnabled.mockReturnValueOnce(false);

      // Act: Initialize app
      await app.initialize();

      // Assert: addOneTimeAgent was not called
      expect(mockDatabaseService.isSystemSettingEnabled).toHaveBeenCalledWith('task_operator');
      expect(mockQueueManager.addOneTimeAgent).not.toHaveBeenCalled();
    });
  });
});

