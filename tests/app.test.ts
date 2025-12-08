import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import request from 'supertest';
import { CursorAgentsApp } from '../src/app.js';
import { QueueManager } from '../src/queue/queue-manager.js';

// Mock QueueManager
jest.mock('../src/queue/queue-manager.js');

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

  beforeEach(() => {
    // Reset mocks
    mockSetBasePath.mockClear();
    
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
      shutdown: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<QueueManager>;

    // Inject mock QueueManager via constructor
    app = new CursorAgentsApp(mockQueueManager);
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
});

