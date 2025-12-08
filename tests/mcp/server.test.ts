import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { MCPServer } from '../../src/mcp/server.js';
import { QueueManager } from '../../src/queue/queue-manager.js';
import type { AgentConfig } from '../../src/mcp/server.js';

// Mock QueueManager - don't mock the module, just create a mock instance

// Mock MCP SDK
jest.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: jest.fn().mockImplementation(() => ({
    setRequestHandler: jest.fn(),
    connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  })),
}));

jest.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: jest.fn().mockImplementation(() => ({})),
}));

describe('MCPServer', () => {
  let mcpServer: MCPServer;
  let mockQueueManager: jest.Mocked<QueueManager>;

  beforeEach(() => {
    // Create mock QueueManager with all required methods
    mockQueueManager = {
      initialize: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      addOneTimeAgent: jest
        .fn<(config: AgentConfig) => Promise<{ id: string; name: string }>>()
        .mockResolvedValue({
          id: 'job-123',
          name: 'test-agent',
        }),
      addRecurringAgent: jest
        .fn<(config: AgentConfig) => Promise<{ id: string; name: string }>>()
        .mockResolvedValue({
          id: 'job-456',
          name: 'recurring-agent',
        }),
      listQueues: jest.fn<() => Promise<string[]>>().mockResolvedValue(['queue1', 'queue2']),
      getAgentStatus: jest.fn<(name: string) => Promise<unknown>>().mockResolvedValue({
        name: 'test-agent',
        isActive: true,
      }),
      removeAgent: jest.fn<(name: string) => Promise<void>>().mockResolvedValue(undefined),
      getQueues: jest.fn<() => unknown[]>().mockReturnValue([]),
      getQueueInfo: jest.fn<(name: string) => Promise<unknown>>().mockResolvedValue(null),
      deleteQueue: jest.fn<(name: string) => Promise<void>>().mockResolvedValue(undefined),
      shutdown: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<QueueManager>;

    // Create MCPServer with mocked QueueManager
    mcpServer = new MCPServer(mockQueueManager);
  });

  describe('create_agent tool', () => {
    it('should create a one-time agent', async () => {
      const config: AgentConfig = {
        name: 'test-agent',
        targetUrl: 'http://example.com/api',
        method: 'GET',
        oneTime: true,
      };

      // Access the private method via type assertion for testing
      // Bind it to the instance to preserve 'this' context
      const handleCreateAgent = (
        mcpServer as unknown as {
          handleCreateAgent: (args: unknown) => Promise<unknown>;
        }
      ).handleCreateAgent.bind(mcpServer);

      const result = await handleCreateAgent(config);

      expect(mockQueueManager.addOneTimeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'test-agent',
          targetUrl: 'http://example.com/api',
          method: 'GET',
        })
      );
      expect(result).toHaveProperty('content');
      
      // Assert JSON structure
      const resultAny = result as { content: Array<{ type: string; text: string }> };
      expect(resultAny.content).toBeDefined();
      expect(resultAny.content.length).toBeGreaterThan(0);
      expect(resultAny.content[0]).toHaveProperty('type', 'text');
      expect(resultAny.content[0]).toHaveProperty('text');
      
      // Parse and assert JSON structure
      const jsonText = resultAny.content[0].text;
      expect(() => JSON.parse(jsonText)).not.toThrow(); // Verify it's valid JSON
      
      const content = JSON.parse(jsonText);
      expect(content).toHaveProperty('success', true);
      expect(content).toHaveProperty('message');
      expect(typeof content.message).toBe('string');
      expect(content.message).toContain('test-agent');
      expect(content.message).toContain('created successfully');
      
      expect(content).toHaveProperty('agent');
      expect(content.agent).toHaveProperty('name', 'test-agent');
      expect(content.agent).toHaveProperty('targetUrl', 'http://example.com/api');
      expect(content.agent).toHaveProperty('method', 'GET');
      expect(content.agent).toHaveProperty('oneTime', true);
      expect(content.agent).toHaveProperty('queue', 'default');
      expect(content.agent.schedule).toBeUndefined(); // oneTime agents don't have schedule
      
      // Assert types
      expect(typeof content.success).toBe('boolean');
      expect(typeof content.message).toBe('string');
      expect(typeof content.agent.name).toBe('string');
      expect(typeof content.agent.targetUrl).toBe('string');
      expect(typeof content.agent.method).toBe('string');
      expect(typeof content.agent.oneTime).toBe('boolean');
      expect(typeof content.agent.queue).toBe('string');
    });

    it('should create a recurring agent', async () => {
      const config: AgentConfig = {
        name: 'recurring-agent',
        targetUrl: 'http://example.com/api',
        method: 'POST',
        schedule: '0 */5 * * * *',
        oneTime: false,
      };

      const handleCreateAgent = (
        mcpServer as unknown as {
          handleCreateAgent: (args: unknown) => Promise<unknown>;
        }
      ).handleCreateAgent.bind(mcpServer);

      const result = await handleCreateAgent(config);

      expect(mockQueueManager.addRecurringAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'recurring-agent',
          targetUrl: 'http://example.com/api',
          method: 'POST',
          schedule: '0 */5 * * * *',
        })
      );
      
      // Assert JSON structure
      const resultAny = result as { content: Array<{ type: string; text: string }> };
      expect(resultAny.content).toBeDefined();
      expect(resultAny.content.length).toBeGreaterThan(0);
      expect(resultAny.content[0]).toHaveProperty('type', 'text');
      expect(resultAny.content[0]).toHaveProperty('text');
      
      // Parse and assert JSON structure
      const jsonText = resultAny.content[0].text;
      expect(() => JSON.parse(jsonText)).not.toThrow(); // Verify it's valid JSON
      
      const content = JSON.parse(jsonText);
      expect(content).toHaveProperty('success', true);
      expect(content).toHaveProperty('message');
      expect(typeof content.message).toBe('string');
      expect(content.message).toContain('recurring-agent');
      expect(content.message).toContain('created successfully');
      
      expect(content).toHaveProperty('agent');
      expect(content.agent).toHaveProperty('name', 'recurring-agent');
      expect(content.agent).toHaveProperty('targetUrl', 'http://example.com/api');
      expect(content.agent).toHaveProperty('method', 'POST');
      expect(content.agent).toHaveProperty('oneTime', false);
      expect(content.agent).toHaveProperty('schedule', '0 */5 * * * *');
      expect(content.agent).toHaveProperty('queue', 'default');
      
      // Assert types
      expect(typeof content.success).toBe('boolean');
      expect(typeof content.message).toBe('string');
      expect(typeof content.agent.name).toBe('string');
      expect(typeof content.agent.targetUrl).toBe('string');
      expect(typeof content.agent.method).toBe('string');
      expect(typeof content.agent.oneTime).toBe('boolean');
      expect(typeof content.agent.schedule).toBe('string');
      expect(typeof content.agent.queue).toBe('string');
    });

    it('should throw error if schedule missing for recurring agent', async () => {
      const config: AgentConfig = {
        name: 'recurring-agent',
        targetUrl: 'http://example.com/api',
        method: 'GET',
        oneTime: false,
        // Missing schedule
      };

      const handleCreateAgent = (
        mcpServer as unknown as {
          handleCreateAgent: (args: unknown) => Promise<unknown>;
        }
      ).handleCreateAgent.bind(mcpServer);

      await expect(handleCreateAgent(config)).rejects.toThrow('Either oneTime must be true or schedule must be provided');
    });
  });

  describe('list_agents tool', () => {
    it('should list all agents', async () => {
      // Arrange: Mock listQueues to return queue names and getAgentStatus to return agent status
      mockQueueManager.listQueues.mockResolvedValue(['queue1', 'queue2']);
      mockQueueManager.getAgentStatus
        .mockResolvedValueOnce({
          name: 'queue1',
          isActive: true,
        })
        .mockResolvedValueOnce({
          name: 'queue2',
          isActive: false,
        });

      const handleListAgents = (
        mcpServer as unknown as {
          handleListAgents: () => Promise<unknown>;
        }
      ).handleListAgents.bind(mcpServer);

      const result = await handleListAgents();

      expect(mockQueueManager.listQueues).toHaveBeenCalled();
      expect(result).toHaveProperty('content');
      
      // Assert JSON structure
      const resultAny = result as { content: Array<{ type: string; text: string }> };
      expect(resultAny.content).toBeDefined();
      expect(resultAny.content.length).toBeGreaterThan(0);
      expect(resultAny.content[0]).toHaveProperty('type', 'text');
      expect(resultAny.content[0]).toHaveProperty('text');
      
      // Parse and assert JSON structure
      const jsonText = resultAny.content[0].text;
      expect(() => JSON.parse(jsonText)).not.toThrow(); // Verify it's valid JSON
      
      const content = JSON.parse(jsonText);
      expect(content).toHaveProperty('agents');
      expect(Array.isArray(content.agents)).toBe(true);
      expect(content.agents.length).toBe(2);
      
      // Assert agent object structure
      const agent1 = content.agents[0];
      expect(agent1).toHaveProperty('name', 'queue1');
      expect(agent1).toHaveProperty('isActive', true);
      expect(typeof agent1.name).toBe('string');
      expect(typeof agent1.isActive).toBe('boolean');
      
      const agent2 = content.agents[1];
      expect(agent2).toHaveProperty('name', 'queue2');
      expect(agent2).toHaveProperty('isActive', false);
      expect(typeof agent2.name).toBe('string');
      expect(typeof agent2.isActive).toBe('boolean');
    });

    it('should return empty array when no agents exist', async () => {
      // Arrange: Mock listQueues to return empty array
      mockQueueManager.listQueues.mockResolvedValue([]);

      const handleListAgents = (
        mcpServer as unknown as {
          handleListAgents: () => Promise<unknown>;
        }
      ).handleListAgents.bind(mcpServer);

      const result = await handleListAgents();

      // Assert JSON structure
      const resultAny = result as { content: Array<{ type: string; text: string }> };
      const jsonText = resultAny.content[0].text;
      const content = JSON.parse(jsonText);
      
      expect(content).toHaveProperty('agents');
      expect(Array.isArray(content.agents)).toBe(true);
      expect(content.agents.length).toBe(0);
    });

    it('should filter out null agent statuses', async () => {
      // Arrange: Mock listQueues to return queue names, but getAgentStatus returns null for some
      mockQueueManager.listQueues.mockResolvedValue(['queue1', 'queue2', 'queue3']);
      mockQueueManager.getAgentStatus
        .mockResolvedValueOnce({
          name: 'queue1',
          isActive: true,
        })
        .mockResolvedValueOnce(null) // This should be filtered out
        .mockResolvedValueOnce({
          name: 'queue3',
          isActive: false,
        });

      const handleListAgents = (
        mcpServer as unknown as {
          handleListAgents: () => Promise<unknown>;
        }
      ).handleListAgents.bind(mcpServer);

      const result = await handleListAgents();

      // Assert JSON structure - null agents should be filtered out
      const resultAny = result as { content: Array<{ type: string; text: string }> };
      const jsonText = resultAny.content[0].text;
      const content = JSON.parse(jsonText);
      
      expect(content).toHaveProperty('agents');
      expect(Array.isArray(content.agents)).toBe(true);
      expect(content.agents.length).toBe(2); // Only 2 non-null agents
      expect(content.agents.every((a: unknown) => a !== null)).toBe(true);
    });
  });

  describe('get_agent_status tool', () => {
    it('should return agent status', async () => {
      // Arrange: Mock getAgentStatus to return complete agent status
      const mockAgentStatus = {
        name: 'test-agent',
        isActive: true,
        targetUrl: 'http://example.com/api',
        method: 'POST' as const,
        headers: { 'Content-Type': 'application/json' },
        body: { key: 'value' },
        schedule: '0 */5 * * * *',
        timeout: 30000,
        queue: 'default',
        lastRun: new Date('2024-01-01T00:00:00Z'),
        nextRun: new Date('2024-01-01T00:05:00Z'),
        jobId: 'job-123',
      };
      mockQueueManager.getAgentStatus.mockResolvedValueOnce(mockAgentStatus);

      const handleGetAgentStatus = (
        mcpServer as unknown as {
          handleGetAgentStatus: (args: { name: string }) => Promise<unknown>;
        }
      ).handleGetAgentStatus.bind(mcpServer);

      const result = await handleGetAgentStatus({ name: 'test-agent' });

      expect(mockQueueManager.getAgentStatus).toHaveBeenCalledWith('test-agent');
      expect(result).toHaveProperty('content');
      
      // Assert JSON structure
      const resultAny = result as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(resultAny.content).toBeDefined();
      expect(resultAny.content.length).toBeGreaterThan(0);
      expect(resultAny.content[0]).toHaveProperty('type', 'text');
      expect(resultAny.content[0]).toHaveProperty('text');
      expect(resultAny.isError).toBeUndefined(); // Should not be an error
      
      // Parse and assert JSON structure
      const jsonText = resultAny.content[0].text;
      expect(() => JSON.parse(jsonText)).not.toThrow(); // Verify it's valid JSON
      
      const content = JSON.parse(jsonText);
      
      // Assert all AgentStatus fields (from PromptStatus)
      expect(content).toHaveProperty('name', 'test-agent');
      expect(content).toHaveProperty('isActive', true);
      expect(typeof content.name).toBe('string');
      expect(typeof content.isActive).toBe('boolean');
      
      // Assert optional PromptStatus fields
      if (content.lastRun) {
        expect(typeof content.lastRun).toBe('string'); // Date is serialized as string
      }
      if (content.nextRun) {
        expect(typeof content.nextRun).toBe('string');
      }
      if (content.jobId) {
        expect(typeof content.jobId).toBe('string');
      }
      
      // Assert AgentStatus-specific fields
      expect(content).toHaveProperty('targetUrl', 'http://example.com/api');
      expect(content).toHaveProperty('method', 'POST');
      expect(content).toHaveProperty('headers');
      expect(typeof content.headers).toBe('object');
      expect(content).toHaveProperty('body');
      expect(content).toHaveProperty('schedule', '0 */5 * * * *');
      expect(content).toHaveProperty('timeout', 30000);
      expect(content).toHaveProperty('queue', 'default');
      
      // Assert types
      expect(typeof content.targetUrl).toBe('string');
      expect(typeof content.method).toBe('string');
      expect(typeof content.schedule).toBe('string');
      expect(typeof content.timeout).toBe('number');
      expect(typeof content.queue).toBe('string');
    });

    it('should return error if agent not found', async () => {
      mockQueueManager.getAgentStatus.mockResolvedValueOnce(null);

      const handleGetAgentStatus = (
        mcpServer as unknown as {
          handleGetAgentStatus: (args: { name: string }) => Promise<unknown>;
        }
      ).handleGetAgentStatus.bind(mcpServer);

      const result = await handleGetAgentStatus({ name: 'non-existent' });
      
      // Assert JSON structure for error case
      const resultAny = result as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(resultAny.isError).toBe(true); // Should be marked as error
      
      const jsonText = resultAny.content[0].text;
      expect(() => JSON.parse(jsonText)).not.toThrow(); // Verify it's valid JSON
      
      const content = JSON.parse(jsonText);
      expect(content).toHaveProperty('error');
      expect(typeof content.error).toBe('string');
      expect(content.error).toContain('non-existent');
      expect(content.error).toContain('not found');

      expect(result).toHaveProperty('isError', true);
    });
  });

  describe('delete_agent tool', () => {
    it('should delete an agent', async () => {
      const handleDeleteAgent = (
        mcpServer as unknown as {
          handleDeleteAgent: (args: { name: string }) => Promise<unknown>;
        }
      ).handleDeleteAgent.bind(mcpServer);

      const result = await handleDeleteAgent({ name: 'test-agent' });

      expect(mockQueueManager.removeAgent).toHaveBeenCalledWith('test-agent');
      expect(result).toHaveProperty('content');
      
      // Assert JSON structure
      const resultAny = result as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(resultAny.content).toBeDefined();
      expect(resultAny.content.length).toBeGreaterThan(0);
      expect(resultAny.content[0]).toHaveProperty('type', 'text');
      expect(resultAny.content[0]).toHaveProperty('text');
      expect(resultAny.isError).toBeUndefined(); // Should not be an error
      
      // Parse and assert JSON structure
      const jsonText = resultAny.content[0].text;
      expect(() => JSON.parse(jsonText)).not.toThrow(); // Verify it's valid JSON
      
      const content = JSON.parse(jsonText);
      expect(content).toHaveProperty('success', true);
      expect(content).toHaveProperty('message');
      expect(typeof content.message).toBe('string');
      expect(content.message).toContain('test-agent');
      expect(content.message).toContain('deleted successfully');
      
      // Assert types
      expect(typeof content.success).toBe('boolean');
      expect(typeof content.message).toBe('string');
    });
  });

  describe('list_queues tool', () => {
    it('should list all queues with info', async () => {
      // Arrange: Mock listQueues and getQueueInfo
      const mockQueueInfo1 = {
        name: 'queue1',
        waiting: 5,
        active: 2,
        completed: 10,
        failed: 1,
        delayed: 3,
        agents: [],
      };
      const mockQueueInfo2 = {
        name: 'queue2',
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        agents: [],
      };
      mockQueueManager.listQueues.mockResolvedValue(['queue1', 'queue2']);
      mockQueueManager.getQueueInfo
        .mockResolvedValueOnce(mockQueueInfo1)
        .mockResolvedValueOnce(mockQueueInfo2);

      const handleListQueues = (
        mcpServer as unknown as {
          handleListQueues: () => Promise<unknown>;
        }
      ).handleListQueues.bind(mcpServer);

      const result = await handleListQueues();

      expect(mockQueueManager.listQueues).toHaveBeenCalled();
      
      // Assert JSON structure
      const resultAny = result as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(resultAny.content).toBeDefined();
      expect(resultAny.content.length).toBeGreaterThan(0);
      expect(resultAny.content[0]).toHaveProperty('type', 'text');
      expect(resultAny.content[0]).toHaveProperty('text');
      expect(resultAny.isError).toBeUndefined();
      
      // Parse and assert JSON structure
      const jsonText = resultAny.content[0].text;
      expect(() => JSON.parse(jsonText)).not.toThrow();
      
      const content = JSON.parse(jsonText);
      expect(content).toHaveProperty('queues');
      expect(Array.isArray(content.queues)).toBe(true);
      expect(content.queues.length).toBe(2);
      
      // Assert queue object structure
      const queue1 = content.queues[0];
      expect(queue1).toHaveProperty('name', 'queue1');
      expect(queue1).toHaveProperty('waiting', 5);
      expect(queue1).toHaveProperty('active', 2);
      expect(queue1).toHaveProperty('completed', 10);
      expect(queue1).toHaveProperty('failed', 1);
      expect(queue1).toHaveProperty('delayed', 3);
      expect(queue1).toHaveProperty('agents');
      expect(Array.isArray(queue1.agents)).toBe(true);
      
      // Assert types
      expect(typeof queue1.name).toBe('string');
      expect(typeof queue1.waiting).toBe('number');
      expect(typeof queue1.active).toBe('number');
      expect(typeof queue1.completed).toBe('number');
      expect(typeof queue1.failed).toBe('number');
      expect(typeof queue1.delayed).toBe('number');
    });

    it('should filter out null queue infos', async () => {
      // Arrange: Mock listQueues to return queue names, but getQueueInfo returns null for some
      mockQueueManager.listQueues.mockResolvedValue(['queue1', 'queue2', 'queue3']);
      mockQueueManager.getQueueInfo
        .mockResolvedValueOnce({
          name: 'queue1',
          waiting: 0,
          active: 0,
          completed: 0,
          failed: 0,
          delayed: 0,
          agents: [],
        })
        .mockResolvedValueOnce(null) // This should be filtered out
        .mockResolvedValueOnce({
          name: 'queue3',
          waiting: 0,
          active: 0,
          completed: 0,
          failed: 0,
          delayed: 0,
          agents: [],
        });

      const handleListQueues = (
        mcpServer as unknown as {
          handleListQueues: () => Promise<unknown>;
        }
      ).handleListQueues.bind(mcpServer);

      const result = await handleListQueues();

      // Assert JSON structure - null queue infos should be filtered out
      const resultAny = result as { content: Array<{ type: string; text: string }> };
      const jsonText = resultAny.content[0].text;
      const content = JSON.parse(jsonText);
      
      expect(content).toHaveProperty('queues');
      expect(Array.isArray(content.queues)).toBe(true);
      expect(content.queues.length).toBe(2); // Only 2 non-null queue infos
      expect(content.queues.every((q: unknown) => q !== null)).toBe(true);
    });
  });

  describe('get_queue_info tool', () => {
    it('should return queue info for existing queue', async () => {
      // Arrange: Mock getQueueInfo to return queue info
      const mockQueueInfo = {
        name: 'test-queue',
        waiting: 5,
        active: 2,
        completed: 10,
        failed: 1,
        delayed: 3,
        agents: [],
      };
      mockQueueManager.getQueueInfo.mockResolvedValueOnce(mockQueueInfo);

      const handleGetQueueInfo = (
        mcpServer as unknown as {
          handleGetQueueInfo: (args: { queueName: string }) => Promise<unknown>;
        }
      ).handleGetQueueInfo.bind(mcpServer);

      const result = await handleGetQueueInfo({ queueName: 'test-queue' });

      expect(mockQueueManager.getQueueInfo).toHaveBeenCalledWith('test-queue');
      
      // Assert JSON structure
      const resultAny = result as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(resultAny.content).toBeDefined();
      expect(resultAny.content.length).toBeGreaterThan(0);
      expect(resultAny.content[0]).toHaveProperty('type', 'text');
      expect(resultAny.content[0]).toHaveProperty('text');
      expect(resultAny.isError).toBeUndefined();
      
      // Parse and assert JSON structure
      const jsonText = resultAny.content[0].text;
      expect(() => JSON.parse(jsonText)).not.toThrow();
      
      const content = JSON.parse(jsonText);
      expect(content).toHaveProperty('name', 'test-queue');
      expect(content).toHaveProperty('waiting', 5);
      expect(content).toHaveProperty('active', 2);
      expect(content).toHaveProperty('completed', 10);
      expect(content).toHaveProperty('failed', 1);
      expect(content).toHaveProperty('delayed', 3);
      expect(content).toHaveProperty('agents');
      expect(Array.isArray(content.agents)).toBe(true);
      
      // Assert types
      expect(typeof content.name).toBe('string');
      expect(typeof content.waiting).toBe('number');
      expect(typeof content.active).toBe('number');
      expect(typeof content.completed).toBe('number');
      expect(typeof content.failed).toBe('number');
      expect(typeof content.delayed).toBe('number');
    });

    it('should return error if queue not found', async () => {
      // Arrange: Mock getQueueInfo to return null
      mockQueueManager.getQueueInfo.mockResolvedValueOnce(null);

      const handleGetQueueInfo = (
        mcpServer as unknown as {
          handleGetQueueInfo: (args: { queueName: string }) => Promise<unknown>;
        }
      ).handleGetQueueInfo.bind(mcpServer);

      const result = await handleGetQueueInfo({ queueName: 'non-existent' });
      
      // Assert JSON structure for error case
      const resultAny = result as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(resultAny.isError).toBe(true);
      
      const jsonText = resultAny.content[0].text;
      expect(() => JSON.parse(jsonText)).not.toThrow();
      
      const content = JSON.parse(jsonText);
      expect(content).toHaveProperty('error');
      expect(typeof content.error).toBe('string');
      expect(content.error).toContain('non-existent');
      expect(content.error).toContain('not found');
    });
  });

  describe('delete_queue tool', () => {
    it('should delete queue successfully', async () => {
      const handleDeleteQueue = (
        mcpServer as unknown as {
          handleDeleteQueue: (args: { queueName: string }) => Promise<unknown>;
        }
      ).handleDeleteQueue.bind(mcpServer);

      const result = await handleDeleteQueue({ queueName: 'test-queue' });

      expect(mockQueueManager.deleteQueue).toHaveBeenCalledWith('test-queue');
      expect(result).toHaveProperty('content');
      
      // Assert JSON structure
      const resultAny = result as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(resultAny.content).toBeDefined();
      expect(resultAny.content.length).toBeGreaterThan(0);
      expect(resultAny.content[0]).toHaveProperty('type', 'text');
      expect(resultAny.content[0]).toHaveProperty('text');
      expect(resultAny.isError).toBeUndefined();
      
      // Parse and assert JSON structure
      const jsonText = resultAny.content[0].text;
      expect(() => JSON.parse(jsonText)).not.toThrow();
      
      const content = JSON.parse(jsonText);
      expect(content).toHaveProperty('success', true);
      expect(content).toHaveProperty('message');
      expect(typeof content.message).toBe('string');
      expect(content.message).toContain('test-queue');
      expect(content.message).toContain('deleted successfully');
      
      // Assert types
      expect(typeof content.success).toBe('boolean');
      expect(typeof content.message).toBe('string');
    });
  });

  describe('start and stop', () => {
    it('should start successfully', async () => {
      await expect(mcpServer.start()).resolves.not.toThrow();
    });

    it('should stop successfully', async () => {
      await expect(mcpServer.stop()).resolves.not.toThrow();
    });
  });
});

