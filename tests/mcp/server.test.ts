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

      await handleCreateAgent(config);

      expect(mockQueueManager.addRecurringAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'recurring-agent',
          targetUrl: 'http://example.com/api',
          method: 'POST',
          schedule: '0 */5 * * * *',
        })
      );
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

      await expect(handleCreateAgent(config)).rejects.toThrow();
    });
  });

  describe('list_agents tool', () => {
    it('should list all agents', async () => {
      mockQueueManager.getAgentStatus.mockResolvedValue({
        name: 'queue1',
        isActive: true,
      });

      const handleListAgents = (
        mcpServer as unknown as {
          handleListAgents: () => Promise<unknown>;
        }
      ).handleListAgents.bind(mcpServer);

      const result = await handleListAgents();

      expect(mockQueueManager.listQueues).toHaveBeenCalled();
      expect(result).toHaveProperty('content');
    });
  });

  describe('get_agent_status tool', () => {
    it('should return agent status', async () => {
      const handleGetAgentStatus = (
        mcpServer as unknown as {
          handleGetAgentStatus: (args: { name: string }) => Promise<unknown>;
        }
      ).handleGetAgentStatus.bind(mcpServer);

      const result = await handleGetAgentStatus({ name: 'test-agent' });

      expect(mockQueueManager.getAgentStatus).toHaveBeenCalledWith('test-agent');
      expect(result).toHaveProperty('content');
    });

    it('should return error if agent not found', async () => {
      mockQueueManager.getAgentStatus.mockResolvedValueOnce(null);

      const handleGetAgentStatus = (
        mcpServer as unknown as {
          handleGetAgentStatus: (args: { name: string }) => Promise<unknown>;
        }
      ).handleGetAgentStatus.bind(mcpServer);

      const result = await handleGetAgentStatus({ name: 'non-existent' });

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

