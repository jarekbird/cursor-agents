import dotenv from 'dotenv';
import { QueueManager } from '../queue/queue-manager.js';
import { MCPServer } from './server.js';
import { logger } from '../logger.js';

// Load environment variables
dotenv.config();

async function main(): Promise<void> {
  const queueManager = new QueueManager();
  const mcpServer = new MCPServer(queueManager);

  try {
    // Initialize queue manager
    await queueManager.initialize();

    // Start MCP server
    await mcpServer.start();

    logger.info('MCP server started and ready for connections');
  } catch (error) {
    logger.error('Failed to start MCP server', { error });
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
