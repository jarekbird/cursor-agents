import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
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
  private server: McpServer;
  private queueManager: QueueManager;
  private transport: StdioServerTransport;

  constructor(queueManager: QueueManager) {
    this.queueManager = queueManager;
    this.server = new McpServer({
      name: 'cursor-agents',
      version: '1.0.0',
    });

    this.transport = new StdioServerTransport();
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Register create_agent tool
    this.server.registerTool(
      'create_agent',
      {
        title: 'Create Agent',
        description:
          'Create a new agent (BullMQ job) that makes HTTP requests to a target URL. Can be one-time or recurring.',
        inputSchema: {
          name: z.string().describe('Unique name for the agent'),
          targetUrl: z
            .string()
            .describe(
              'Target URL to hit (can be public URL or Docker network URL like http://cursor-runner:3001/health)'
            ),
          method: z
            .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
            .optional()
            .default('POST')
            .describe('HTTP method to use'),
          headers: z
            .record(z.string())
            .optional()
            .describe('HTTP headers to include in the request'),
          body: z.unknown().optional().describe('Request body (for POST, PUT, PATCH methods)'),
          schedule: z
            .string()
            .optional()
            .describe(
              'Cron pattern (e.g., "0 */5 * * * *" for every 5 minutes) or interval (e.g., "every 30 seconds"). Required if oneTime is false.'
            ),
          oneTime: z
            .boolean()
            .optional()
            .default(false)
            .describe(
              'If true, run the agent once immediately. If false, use schedule for recurring execution.'
            ),
          timeout: z.number().optional().default(30000).describe('Request timeout in milliseconds'),
        },
      },
      async (args) => {
        // Log to both Winston logger (for structured logs) and stderr (for visibility)
        const logData = {
          tool: 'create_agent',
          args: {
            name: args.name,
            targetUrl: args.targetUrl,
            method: args.method,
            hasBody: !!args.body,
            schedule: args.schedule,
            oneTime: args.oneTime,
            timeout: args.timeout,
          },
        };
        logger.info('MCP tool called', logData);
        process.stderr.write(`[MCP] tool called: create_agent ${JSON.stringify(logData)}\n`);
        try {
          const result = await this.handleCreateAgent(args);
          logger.info('MCP tool completed', { tool: 'create_agent', success: !result.isError });
          process.stderr.write(`[MCP] tool completed: create_agent success=${!result.isError}\n`);
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error('MCP tool error', { tool: 'create_agent', error: errorMessage });
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
      }
    );

    // Register list_agents tool
    this.server.registerTool(
      'list_agents',
      {
        title: 'List Agents',
        description: 'List all active agents',
        inputSchema: {},
      },
      async () => {
        logger.info('MCP tool called', { tool: 'list_agents' });
        process.stderr.write(`[MCP] tool called: list_agents\n`);
        try {
          const result = await this.handleListAgents();
          logger.info('MCP tool completed', { tool: 'list_agents', success: !result.isError });
          process.stderr.write(`[MCP] tool completed: list_agents success=${!result.isError}\n`);
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error('MCP tool error', { tool: 'list_agents', error: errorMessage });
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
      }
    );

    // Register get_agent_status tool
    this.server.registerTool(
      'get_agent_status',
      {
        title: 'Get Agent Status',
        description: 'Get the status of a specific agent',
        inputSchema: {
          name: z.string().describe('Name of the agent'),
        },
      },
      async (args) => {
        logger.info('MCP tool called', { tool: 'get_agent_status', args: { name: args.name } });
        process.stderr.write(`[MCP] tool called: get_agent_status name=${args.name}\n`);
        try {
          const result = await this.handleGetAgentStatus(args);
          logger.info('MCP tool completed', { tool: 'get_agent_status', success: !result.isError });
          process.stderr.write(
            `[MCP] tool completed: get_agent_status success=${!result.isError}\n`
          );
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error('MCP tool error', { tool: 'get_agent_status', error: errorMessage });
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
      }
    );

    // Register delete_agent tool
    this.server.registerTool(
      'delete_agent',
      {
        title: 'Delete Agent',
        description: 'Delete/remove an agent',
        inputSchema: {
          name: z.string().describe('Name of the agent to delete'),
        },
      },
      async (args) => {
        logger.info('MCP tool called', { tool: 'delete_agent', args: { name: args.name } });
        process.stderr.write(`[MCP] tool called: delete_agent name=${args.name}\n`);
        try {
          const result = await this.handleDeleteAgent(args);
          logger.info('MCP tool completed', { tool: 'delete_agent', success: !result.isError });
          process.stderr.write(`[MCP] tool completed: delete_agent success=${!result.isError}\n`);
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error('MCP tool error', { tool: 'delete_agent', error: errorMessage });
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
      }
    );

    // Register agent resources dynamically
    // Use ResourceTemplate with a list function to provide all available agents
    logger.info('Registering agent resources...');
    this.server.registerResource(
      'agent',
      new ResourceTemplate('agent://{name}', {
        list: async (_extra) => {
          logger.info('MCP resource list requested', { resourceType: 'agent' });
          const queues = await this.queueManager.listQueues();
          logger.info('Listing agent resources', { queueCount: queues.length });
          const resources = queues.map((name) => ({
            uri: `agent://${name}`,
            name: name,
            description: `Agent: ${name}`,
            mimeType: 'application/json',
          }));
          logger.info('MCP resource list completed', {
            resourceType: 'agent',
            resourceCount: resources.length,
          });
          return { resources };
        },
      }),
      {
        title: 'Agent',
        description: 'Agent configuration and status',
        mimeType: 'application/json',
      },
      async (uri, params) => {
        const name = typeof params.name === 'string' ? params.name : params.name[0];
        logger.info('MCP resource read requested', { resourceType: 'agent', uri: uri.href, name });
        logger.info('Reading agent resource', { uri: uri.href, name });
        const status = await this.queueManager.getAgentStatus(name);

        if (!status) {
          logger.warn('MCP resource not found', { resourceType: 'agent', uri: uri.href, name });
          throw new Error(`Agent "${name}" not found`);
        }

        logger.info('MCP resource read completed', { resourceType: 'agent', uri: uri.href, name });
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(status, null, 2),
            },
          ],
        };
      }
    );
    logger.info('Agent resources registered successfully');
  }

  private async handleCreateAgent(args: unknown): Promise<{
    content: Array<{ type: 'text'; text: string }>;
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
          type: 'text' as const,
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

  private async handleListAgents(): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }> {
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
          type: 'text' as const,
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

  private async handleGetAgentStatus(args: { name: string }): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }> {
    const { name } = args;
    const status = await this.queueManager.getAgentStatus(name);

    if (!status) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: `Agent "${name}" not found` }, null, 2),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(status, null, 2),
        },
      ],
    };
  }

  private async handleDeleteAgent(args: { name: string }): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }> {
    const { name } = args;
    await this.queueManager.removeAgent(name);

    return {
      content: [
        {
          type: 'text' as const,
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
