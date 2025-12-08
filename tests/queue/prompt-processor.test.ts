import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { PromptProcessor } from '../../src/queue/prompt-processor.js';
import type { AgentJobData, PromptJobData } from '../../src/queue/prompt-processor.js';
import { QueueManager } from '../../src/queue/queue-manager.js';

describe('PromptProcessor', () => {
  let processor: PromptProcessor;
  let mockFetch: jest.MockedFunction<typeof fetch>;
  let mockQueueManager: jest.Mocked<QueueManager>;

  beforeEach(() => {
    mockQueueManager = {
      addDelayedAgent: jest.fn<() => Promise<{ id: string; name: string } | null>>().mockResolvedValue({ id: 'job-1', name: 'test-agent' }),
    } as unknown as jest.Mocked<QueueManager>;
    processor = new PromptProcessor(mockQueueManager);
    mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
    global.fetch = mockFetch;
    process.env.CURSOR_RUNNER_URL = 'http://cursor-runner:3001';
  });

  describe('processAgentJob', () => {
    it('should make GET request successfully', async () => {
      const jobData: AgentJobData = {
        agentName: 'test-agent',
        targetUrl: 'http://example.com/api',
        method: 'GET',
        timeout: 5000,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ success: true }),
      } as Response);

      await processor.process(jobData);

      expect(mockFetch).toHaveBeenCalledWith('http://example.com/api', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: expect.any(AbortSignal),
      });
    });

    it('should make POST request with body', async () => {
      const jobData: AgentJobData = {
        agentName: 'test-agent',
        targetUrl: 'http://example.com/api',
        method: 'POST',
        body: { key: 'value' },
        headers: { Authorization: 'Bearer token' },
        timeout: 5000,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ success: true }),
      } as Response);

      await processor.process(jobData);

      expect(mockFetch).toHaveBeenCalledWith('http://example.com/api', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        },
        body: JSON.stringify({ key: 'value' }),
        signal: expect.any(AbortSignal),
      });
    });

    it('should handle HTTP errors', async () => {
      const jobData: AgentJobData = {
        agentName: 'test-agent',
        targetUrl: 'http://example.com/api',
        method: 'GET',
        timeout: 5000,
      };

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => JSON.stringify({ error: 'Not found' }),
      } as Response);

      await expect(processor.process(jobData)).rejects.toThrow();
    });

    it('should handle network errors', async () => {
      const jobData: AgentJobData = {
        agentName: 'test-agent',
        targetUrl: 'http://example.com/api',
        method: 'GET',
        timeout: 5000,
      };

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(processor.process(jobData)).rejects.toThrow('Network error');
    });

    it('should handle timeout', async () => {
      const jobData: AgentJobData = {
        agentName: 'test-agent',
        targetUrl: 'http://example.com/api',
        method: 'GET',
        timeout: 100,
      };

      // Mock fetch to never resolve (simulating timeout)
      mockFetch.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            // AbortController will reject with AbortError
            setTimeout(() => {
              const error = new Error('The operation was aborted');
              error.name = 'AbortError';
              reject(error);
            }, 150);
          })
      );

      await expect(processor.process(jobData)).rejects.toThrow();
    });

    it('should parse JSON response', async () => {
      const jobData: AgentJobData = {
        agentName: 'test-agent',
        targetUrl: 'http://example.com/api',
        method: 'GET',
        timeout: 5000,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ data: 'test' }),
      } as Response);

      await processor.process(jobData);

      expect(mockFetch).toHaveBeenCalled();
    });

    it('should handle non-JSON response', async () => {
      const jobData: AgentJobData = {
        agentName: 'test-agent',
        targetUrl: 'http://example.com/api',
        method: 'GET',
        timeout: 5000,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => 'plain text response',
      } as Response);

      await processor.process(jobData);

      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe('processPromptJob', () => {
    it('should call cursor-runner API', async () => {
      const jobData: PromptJobData = {
        prompt: 'Test prompt',
        options: {
          repository: 'test-repo',
          branch: 'main',
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ success: true }),
      } as Response);

      await processor.process(jobData);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://cursor-runner:3001/cursor/execute',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            prompt: 'Test prompt',
            repository: 'test-repo',
            branchName: 'main',
          }),
        })
      );
    });

    it('should handle cursor-runner errors gracefully', async () => {
      const jobData: PromptJobData = {
        prompt: 'Test prompt',
      };

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => JSON.stringify({ error: 'Server error' }),
      } as Response);

      // Should not throw, just log
      await processor.process(jobData);

      expect(mockFetch).toHaveBeenCalled();
    });

    it('should handle network errors gracefully', async () => {
      const jobData: PromptJobData = {
        prompt: 'Test prompt',
      };

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      // Should not throw, just log
      await processor.process(jobData);

      expect(mockFetch).toHaveBeenCalled();
    });

    it('should use default branch if not provided', async () => {
      const jobData: PromptJobData = {
        prompt: 'Test prompt',
        options: {
          repository: 'test-repo',
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ success: true }),
      } as Response);

      await processor.process(jobData);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({
            prompt: 'Test prompt',
            repository: 'test-repo',
            branchName: 'main',
          }),
        })
      );
    });
  });
});

