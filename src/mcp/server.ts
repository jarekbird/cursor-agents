import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { QueueManager } from '../queue/queue-manager.js';
import { logger } from '../logger.js';

export interface AgentConfig {
  name: string;
  targetUrl: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: unknown;
  schedule?: string; // Cron pattern or interval for recurring jobs
  oneTime?: boolean; // If true, run once immediately; if false, use schedule
  timeout?: number; // Request timeout in milliseconds
}

export class MCPServer {
  private server: Server;
  private queueManager: QueueManager;
  private transport: StdioServerTransport;

  constructor(queueManager: QueueManager) {
    this.queueManager = queueManager;
    this.server = new Server(
      {
        name: 'cursor-agents',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.transport = new StdioServerTransport();
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'create_agent',
            description:
              'Create a new agent (BullMQ job) that makes HTTP requests to a target URL. Can be one-time or recurring.',
            inputSchema: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Unique name for the agent',
                },
                targetUrl: {
                  type: 'string',
                  description:
                    'Target URL to hit (can be public URL or Docker network URL like http://cursor-runner:3001/health)',
                },
                method: {
                  type: 'string',
                  enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
                  description: 'HTTP method to use',
                  default: 'POST',
                },
                headers: {
                  type: 'object',
                  description: 'HTTP headers to include in the request',
                  additionalProperties: { type: 'string' },
                },
                body: {
                  type: 'object',
                  description: 'Request body (for POST, PUT, PATCH methods)',
                },
                schedule: {
                  type: 'string',
                  description:
                    'Cron pattern (e.g., "0 */5 * * * *" for every 5 minutes) or interval (e.g., "every 30 seconds"). Required if oneTime is false.',
                },
                oneTime: {
                  type: 'boolean',
                  description:
                    'If true, run the agent once immediately. If false, use schedule for recurring execution.',
                  default: false,
                },
                timeout: {
                  type: 'number',
                  description: 'Request timeout in milliseconds',
                  default: 30000,
                },
              },
              required: ['name', 'targetUrl'],
            },
          },
          {
            name: 'list_agents',
            description: 'List all active agents',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'get_agent_status',
            description: 'Get the status of a specific agent',
            inputSchema: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Name of the agent',
                },
              },
              required: ['name'],
            },
          },
          {
            name: 'delete_agent',
            description: 'Delete/remove an agent',
            inputSchema: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Name of the agent to delete',
                },
              },
              required: ['name'],
            },
          },
        ] as Tool[],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'create_agent':
            return await this.handleCreateAgent(args);
          case 'list_agents':
            return await this.handleListAgents();
          case 'get_agent_status':
            return await this.handleGetAgentStatus(args as { name: string });
          case 'delete_agent':
            return await this.handleDeleteAgent(args as { name: string });
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('MCP tool error', { tool: name, error: errorMessage });
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private async handleCreateAgent(args: unknown): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }> {
    const config = args as AgentConfig;
    const {
      name,
      targetUrl,
      method = 'POST',
      headers = {},
      body,
      schedule,
      oneTime = false,
      timeout = 30000,
    } = config;

    if (!oneTime && !schedule) {
      throw new Error('Either oneTime must be true or schedule must be provided');
    }

    // Add the agent as a BullMQ job
    if (oneTime) {
      // For one-time jobs, we'll add it to a queue and process immediately
      await this.queueManager.addOneTimeAgent({
        name,
        targetUrl,
        method,
        headers,
        body,
        timeout,
      });
    } else {
      // For recurring jobs, use the schedule
      await this.queueManager.addRecurringAgent({
        name,
        targetUrl,
        method,
        headers,
        body,
        schedule: schedule!,
        timeout,
      });
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              message: `Agent "${name}" created successfully`,
              agent: {
                name,
                targetUrl,
                method,
                oneTime,
                schedule: oneTime ? undefined : schedule,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleListAgents() {
    const queues = await this.queueManager.listQueues();
    const agents = await Promise.all(
      queues.map(async (name) => {
        const status = await this.queueManager.getAgentStatus(name);
        return status;
      })
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              agents: agents.filter((a) => a !== null),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleGetAgentStatus(args: { name: string }) {
    const { name } = args;
    const status = await this.queueManager.getAgentStatus(name);

    if (!status) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: `Agent "${name}" not found` }, null, 2),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(status, null, 2),
        },
      ],
    };
  }

  private async handleDeleteAgent(args: { name: string }) {
    const { name } = args;
    await this.queueManager.removeAgent(name);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              message: `Agent "${name}" deleted successfully`,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  async start(): Promise<void> {
    await this.server.connect(this.transport);
    logger.info('MCP server started');
  }

  async stop(): Promise<void> {
    await this.server.close();
    logger.info('MCP server stopped');
  }
}
