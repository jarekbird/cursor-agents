import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import request from 'supertest';
import { CursorAgentsApp } from '../src/app.js';
import { QueueManager } from '../src/queue/queue-manager.js';
import { PromptProcessor } from '../src/queue/prompt-processor.js';

// Mock dependencies
jest.mock('../src/queue/queue-manager.js');
jest.mock('../src/queue/prompt-processor.js');

// Mock Bull Board
jest.mock('@bull-board/api', () => ({
  createBullBoard: jest.fn(),
}));

jest.mock('@bull-board/api/bullMQAdapter', () => ({
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

describe('Integration Tests', () => {
  let app: CursorAgentsApp;
  let mockQueueManager: jest.Mocked<QueueManager>;
  let mockFetch: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
    global.fetch = mockFetch;

    mockQueueManager = {
      initialize: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      listQueues: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
      addRecurringPrompt: jest
        .fn<() => Promise<{ id: string; name: string }>>()
        .mockResolvedValue({
          id: 'job-123',
          name: 'test-prompt',
        }),
      addOneTimeAgent: jest
        .fn<() => Promise<{ id: string; name: string }>>()
        .mockResolvedValue({
          id: 'job-456',
          name: 'test-agent',
        }),
      addRecurringAgent: jest
        .fn<() => Promise<{ id: string; name: string }>>()
        .mockResolvedValue({
          id: 'job-789',
          name: 'recurring-agent',
        }),
      getPromptStatus: jest.fn<() => Promise<unknown>>().mockResolvedValue(null),
      getAgentStatus: jest.fn<() => Promise<unknown>>().mockResolvedValue(null),
      removeRecurringPrompt: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      removeAgent: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
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

  describe('Agent Lifecycle', () => {
    it('should create, check status, and delete an agent', async () => {
      await app.initialize();

      // Create agent via API
      const createResponse = await request(app.app).post('/prompts/recurring').send({
        name: 'test-agent',
        prompt: 'Test prompt',
        schedule: '0 */5 * * * *',
      });

      expect(createResponse.status).toBe(200);

      // Check status
      mockQueueManager.getPromptStatus.mockResolvedValueOnce({
        name: 'test-agent',
        isActive: true,
      });

      const statusResponse = await request(app.app).get('/prompts/test-agent');

      expect(statusResponse.status).toBe(200);

      // Delete agent
      const deleteResponse = await request(app.app).delete('/prompts/test-agent');

      expect(deleteResponse.status).toBe(200);
      expect(mockQueueManager.removeRecurringPrompt).toHaveBeenCalledWith('test-agent');
    });
  });

  describe('HTTP Agent Execution', () => {
    it('should process HTTP agent job successfully', async () => {
      const processor = new PromptProcessor();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ success: true }),
      } as Response);

      await processor.process({
        agentName: 'test-agent',
        targetUrl: 'http://example.com/api',
        method: 'GET',
        timeout: 5000,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://example.com/api',
        expect.objectContaining({
          method: 'GET',
        })
      );
    });
  });

  describe('Error Handling', () => {
    it('should handle Redis connection failures gracefully', async () => {
      mockQueueManager.initialize.mockRejectedValueOnce(new Error('Redis connection failed'));

      await expect(app.initialize()).rejects.toThrow('Redis connection failed');
    });

    it('should handle HTTP request failures in agents', async () => {
      const processor = new PromptProcessor();

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => JSON.stringify({ error: 'Server error' }),
      } as Response);

      await expect(
        processor.process({
          agentName: 'test-agent',
          targetUrl: 'http://example.com/api',
          method: 'GET',
          timeout: 5000,
        })
      ).rejects.toThrow();
    });
  });

  describe('Queue Management', () => {
    it('should list all queues', async () => {
      mockQueueManager.listQueues.mockResolvedValueOnce(['queue1', 'queue2', 'queue3']);
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
      const body = response.body;
      expect(body.queues).toHaveLength(3);
      expect(body.queues[0]).toHaveProperty('name', 'queue1');
    });
  });
});

