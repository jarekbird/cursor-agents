import dotenv from 'dotenv';
import { CursorAgentsApp } from './app.js';

// Load environment variables
dotenv.config();

const port = parseInt(process.env.PORT || '3002', 10);

async function main(): Promise<void> {
  const app = new CursorAgentsApp();

  try {
    await app.initialize();
    await app.start(port);
    console.log(`Cursor Agents application started on port ${port}`);
  } catch (error) {
    console.error('Failed to start application:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  process.exit(0);
});

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
