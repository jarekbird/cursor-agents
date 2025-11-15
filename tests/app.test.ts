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

jest.mock('@bull-board/api/bullMQAdapter.js', () => ({
  BullMQAdapter: jest.fn(),
}));

jest.mock('@bull-board/express', () => ({
  ExpressAdapter: jest.fn().mockImplementation(() => ({
    setBasePath: jest.fn(),
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

      await app.initialize();

      const response = await request(app.app).get('/queues');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('queues');
      expect(response.body.queues).toEqual(['queue1', 'queue2']);
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

