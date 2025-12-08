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

  describe('re-enqueueing', () => {
    it('should re-enqueue agent when response has requeue: true', async () => {
      // Arrange: Mock QueueManager, HTTP response with requeue
      const jobData: AgentJobData = {
        agentName: 'test-agent',
        targetUrl: 'http://example.com',
        method: 'GET',
        timeout: 5000,
      };
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({
          requeue: true,
          delay: 5000,
          condition: 'retry after delay',
        }),
      } as Response);
      
      // Act
      await processor.process(jobData);
      
      // Assert
      expect(mockQueueManager.addDelayedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'test-agent',
          targetUrl: 'http://example.com',
          method: 'GET',
          delay: 5000,
        })
      );
    });

    it('should preserve original agent config when re-enqueueing', async () => {
      // Arrange: Mock QueueManager, HTTP response with requeue, specific agent config
      const jobData: AgentJobData = {
        agentName: 'test-agent',
        targetUrl: 'http://example.com',
        method: 'POST',
        headers: { 'X-Custom': 'value' },
        body: { key: 'value' },
        timeout: 10000,
        queue: 'custom-queue',
      };
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({
          requeue: true,
          delay: 5000,
        }),
      } as Response);
      
      // Act
      await processor.process(jobData);
      
      // Assert: addDelayedAgent called with original agent config
      expect(mockQueueManager.addDelayedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'test-agent',
          targetUrl: 'http://example.com',
          method: 'POST',
          headers: { 'X-Custom': 'value' },
          body: { key: 'value' },
          timeout: 10000,
          queue: 'custom-queue',
          delay: 5000,
        })
      );
    });

    it('should not re-enqueue when requeue flag is missing', async () => {
      // Arrange: Response without requeue field
      const jobData: AgentJobData = {
        agentName: 'test-agent',
        targetUrl: 'http://example.com',
        method: 'GET',
        timeout: 5000,
      };
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ success: true }), // No requeue field
      } as Response);
      
      // Act
      await processor.process(jobData);
      
      // Assert
      expect(mockQueueManager.addDelayedAgent).not.toHaveBeenCalled();
    });

    it('should not re-enqueue when requeue is false', async () => {
      // Arrange: Response with requeue: false
      const jobData: AgentJobData = {
        agentName: 'test-agent',
        targetUrl: 'http://example.com',
        method: 'GET',
        timeout: 5000,
      };
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ requeue: false }),
      } as Response);
      
      // Act
      await processor.process(jobData);
      
      // Assert
      expect(mockQueueManager.addDelayedAgent).not.toHaveBeenCalled();
    });
  });

  describe('task-operator internal jobs', () => {
    it('should not process when task operator is disabled', async () => {
      // Arrange: Job with targetUrl: 'task-operator://internal', mock isTaskOperatorEnabled to return false
      const jobData: AgentJobData = {
        agentName: 'task-operator',
        targetUrl: 'task-operator://internal',
        method: 'GET',
      };
      
      const { TaskOperatorService } = await import('../../src/services/task-operator-service.js');
      const mockTaskOperatorService = {
        isTaskOperatorEnabled: jest.fn<() => boolean>().mockReturnValue(false),
        processNextTask: jest.fn<() => Promise<{ processed: boolean; taskId?: number; reason?: string }>>(),
      };
      jest.spyOn(TaskOperatorService, 'getInstance').mockReturnValue(mockTaskOperatorService as any);
      
      // Act
      await processor.process(jobData);
      
      // Assert: processNextTask not called, addDelayedAgent not called
      expect(mockTaskOperatorService.processNextTask).not.toHaveBeenCalled();
      expect(mockQueueManager.addDelayedAgent).not.toHaveBeenCalled();
    });

    it('should re-enqueue with 5000ms delay when task is processed', async () => {
      // Arrange: isTaskOperatorEnabled returns true, processNextTask returns { processed: true, taskId: 1 }
      const { TaskOperatorService } = await import('../../src/services/task-operator-service.js');
      const mockTaskOperatorService = {
        isTaskOperatorEnabled: jest.fn<() => boolean>().mockReturnValue(true),
        processNextTask: jest.fn<() => Promise<{ processed: boolean; taskId?: number; reason?: string }>>().mockResolvedValue({ processed: true, taskId: 1 }),
      };
      jest.spyOn(TaskOperatorService, 'getInstance').mockReturnValue(mockTaskOperatorService as any);
      
      // Create new processor with mocked service
      const testProcessor = new PromptProcessor(mockQueueManager);
      
      const jobData: AgentJobData = {
        agentName: 'task-operator',
        targetUrl: 'task-operator://internal',
        method: 'GET',
      };
      
      // Act
      await testProcessor.process(jobData);
      
      // Assert: addDelayedAgent called with delay ~5000ms
      expect(mockQueueManager.addDelayedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'task-operator',
          targetUrl: 'task-operator://internal',
          delay: expect.any(Number),
        })
      );
      const callArgs = (mockQueueManager.addDelayedAgent as jest.Mock).mock.calls[0][0] as { delay: number };
      expect(callArgs.delay).toBe(5000); // Exact value from implementation
    });

    it('should re-enqueue with 5000ms delay when no tasks or lock held', async () => {
      // Arrange: processNextTask returns { processed: false, reason: 'no_tasks' } or 'lock_held'
      const { TaskOperatorService } = await import('../../src/services/task-operator-service.js');
      const mockTaskOperatorService = {
        isTaskOperatorEnabled: jest.fn<() => boolean>().mockReturnValue(true),
        processNextTask: jest.fn<() => Promise<{ processed: boolean; taskId?: number; reason?: string }>>().mockResolvedValue({ processed: false, reason: 'no_tasks' }),
      };
      jest.spyOn(TaskOperatorService, 'getInstance').mockReturnValue(mockTaskOperatorService as any);
      
      // Create new processor with mocked service
      const testProcessor = new PromptProcessor(mockQueueManager);
      
      const jobData: AgentJobData = {
        agentName: 'task-operator',
        targetUrl: 'task-operator://internal',
        method: 'GET',
      };
      
      // Act
      await testProcessor.process(jobData);
      
      // Assert: addDelayedAgent called with delay ~5000ms
      expect(mockQueueManager.addDelayedAgent).toHaveBeenCalled();
      const callArgs = (mockQueueManager.addDelayedAgent as jest.Mock).mock.calls[0][0] as { delay: number };
      expect(callArgs.delay).toBe(5000); // Exact value from implementation
    });

    it('should re-enqueue with 10000ms delay when processNextTask throws', async () => {
      // Arrange: processNextTask throws error
      const { TaskOperatorService } = await import('../../src/services/task-operator-service.js');
      const mockTaskOperatorService = {
        isTaskOperatorEnabled: jest.fn<() => boolean>().mockReturnValue(true),
        processNextTask: jest.fn<() => Promise<{ processed: boolean; taskId?: number; reason?: string }>>().mockRejectedValue(new Error('Processing error')),
      };
      jest.spyOn(TaskOperatorService, 'getInstance').mockReturnValue(mockTaskOperatorService as any);
      
      // Create new processor with mocked service
      const testProcessor = new PromptProcessor(mockQueueManager);
      
      const jobData: AgentJobData = {
        agentName: 'task-operator',
        targetUrl: 'task-operator://internal',
        method: 'GET',
      };
      
      const loggerErrorSpy = jest.spyOn((await import('../../src/logger.js')).logger, 'error');
      
      // Act
      await testProcessor.process(jobData);
      
      // Assert: addDelayedAgent called with delay ~10000ms, error is logged
      expect(mockQueueManager.addDelayedAgent).toHaveBeenCalled();
      const callArgs = (mockQueueManager.addDelayedAgent as jest.Mock).mock.calls[0][0] as { delay: number };
      expect(callArgs.delay).toBe(10000); // Exact value from implementation
      expect(loggerErrorSpy).toHaveBeenCalled();
      
      loggerErrorSpy.mockRestore();
    });

    it('should log skip when addDelayedAgent returns null', async () => {
      // Arrange: addDelayedAgent returns null
      const { TaskOperatorService } = await import('../../src/services/task-operator-service.js');
      const mockTaskOperatorService = {
        isTaskOperatorEnabled: jest.fn<() => boolean>().mockReturnValue(true),
        processNextTask: jest.fn<() => Promise<{ processed: boolean; taskId?: number; reason?: string }>>().mockResolvedValue({ processed: false, reason: 'no_tasks' }),
      };
      jest.spyOn(TaskOperatorService, 'getInstance').mockReturnValue(mockTaskOperatorService as any);
      
      // Create new processor with mocked service
      const testProcessor = new PromptProcessor(mockQueueManager);
      
      (mockQueueManager.addDelayedAgent as jest.Mock<() => Promise<{ id: string; name: string } | null>>).mockResolvedValueOnce(null);
      const loggerWarnSpy = jest.spyOn((await import('../../src/logger.js')).logger, 'warn');
      
      const jobData: AgentJobData = {
        agentName: 'task-operator',
        targetUrl: 'task-operator://internal',
        method: 'GET',
      };
      
      // Act
      await testProcessor.process(jobData);
      
      // Assert: Skip message logged (it's a warn, not debug)
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('skip'),
        expect.any(Object)
      );
      
      loggerWarnSpy.mockRestore();
    });
  });
});

