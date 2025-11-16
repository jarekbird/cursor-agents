import dotenv from 'dotenv';
import { QueueManager } from '../queue/queue-manager.js';
import { MCPServer } from './server.js';
import { logger } from '../logger.js';

// Load environment variables
dotenv.config();

async function main(): Promise<void> {
  // Write startup message to stderr so cursor-cli can see it
  // (MCP uses stdio, so stderr is the only way to log during initialization)
  const logToStderr = (message: string, data?: unknown) => {
    const logLine = data ? `${message} ${JSON.stringify(data)}\n` : `${message}\n`;
    process.stderr.write(logLine);
  };

  logToStderr('cursor-agents MCP server: Starting initialization...');
  logToStderr('cursor-agents MCP server: REDIS_URL', {
    REDIS_URL: process.env.REDIS_URL || 'not set',
  });

  const queueManager = new QueueManager();
  const mcpServer = new MCPServer(queueManager);

  try {
    // Initialize queue manager
    logToStderr('cursor-agents MCP server: Initializing QueueManager...');
    await queueManager.initialize();
    logToStderr('cursor-agents MCP server: QueueManager initialized successfully');

    // Start MCP server
    logToStderr('cursor-agents MCP server: Starting MCP server transport...');
    await mcpServer.start();
    logToStderr('cursor-agents MCP server: MCP server started and ready for connections');

    // Also log via winston (for file logs if configured)
    logger.info('MCP server started and ready for connections');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    // Write detailed error to stderr so cursor-cli can see it
    logToStderr('cursor-agents MCP server: ERROR - Failed to start MCP server', {
      error: errorMessage,
      stack: errorStack,
      REDIS_URL: process.env.REDIS_URL,
    });

    // Also log via winston
    logger.error('Failed to start MCP server', { error });

    // Give a moment for stderr to flush before exiting
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully...');
  process.exit(0);
});

main().catch((error) => {
  logger.error('Unhandled error', { error });
  process.exit(1);
});
