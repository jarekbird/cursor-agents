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

jest.mock('@bull-board/api/bullMQAdapter', () => ({
  BullMQAdapter: jest.fn(),
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

