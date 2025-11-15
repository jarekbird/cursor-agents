# cursor-agents

Node.js + TypeScript application for managing recurring/ongoing prompts using BullMQ. This application uses the shared Redis instance for queue management.

## Overview

cursor-agents provides a service for scheduling and managing recurring prompts that can be executed periodically. It uses BullMQ for job queue management and connects to the shared Redis instance used by other services in the Virtual Assistant system.

## Features

- **Recurring Prompts**: Schedule prompts to run on a cron schedule or at intervals
- **Queue Management**: Manage multiple prompt queues with BullMQ
- **Shared Redis**: Uses the shared Redis instance for queue persistence
- **REST API**: HTTP endpoints for managing prompts
- **TypeScript**: Full TypeScript support with type safety

## Prerequisites

- Node.js 18+
- Redis (shared instance via Docker network)
- Docker and Docker Compose (for containerized deployment)

## Installation

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Edit .env with your configuration
```

## Configuration

Edit `.env` file with your settings:

```env
# Server Configuration
PORT=3002
NODE_ENV=development

# Redis Configuration (for BullMQ)
# In Docker: Use redis://redis:6379/0 (shared Redis instance)
# Local development: Use redis://localhost:6379/0
REDIS_URL=redis://redis:6379/0

# BullMQ Configuration
BULLMQ_CONCURRENCY=5

# Optional: Cursor runner URL for processing prompts
CURSOR_RUNNER_URL=http://cursor-runner:3001
```

## Usage

### Local Development

```bash
# Start in development mode (with hot reload)
npm run dev

# Or build and start
npm run build
npm start
```

### Docker Deployment

```bash
# Build and start
docker-compose up -d

# View logs
docker-compose logs -f cursor-agents

# Stop
docker-compose down
```

## API Endpoints

### Health Check
```
GET /health
```

Returns service health status.

### List Queues
```
GET /queues
```

Returns list of all active prompt queues.

### Add Recurring Prompt
```
POST /prompts/recurring
Content-Type: application/json

{
  "name": "daily-check",
  "prompt": "Check system status and report",
  "schedule": "0 9 * * *",  // Cron pattern
  "options": {
    "repository": "my-repo",
    "branch": "main",
    "maxIterations": 5
  }
}
```

Schedule options:
- **Cron pattern**: `"0 9 * * *"` (runs at 9 AM daily)
- **Interval**: `{ every: 60000 }` (runs every 60 seconds)
- **Repeat options**: See [BullMQ RepeatOptions](https://docs.bullmq.io/guide/jobs/repeatable-jobs)

### Get Prompt Status
```
GET /prompts/:name
```

Returns status of a specific prompt including last run and next run times.

### Remove Recurring Prompt
```
DELETE /prompts/:name
```

Removes a recurring prompt and stops its execution.

## Architecture

```
┌─────────────────────────────────────────┐
│  Docker Volume: shared_redis_data       │
│  Mounted at: /data (inside Redis container) │
└───────────────────▲─────────────────────┘
                    │
┌───────────────────┴─────────────────────┐
│  Redis Service (virtual-assistant-redis)│
│  Listens on: 6379                       │
└───────────────────┬─────────────────────┘
                    │ Docker Network: virtual-assistant-network
                    │ (redis://redis:6379/0)
┌───────────────────┴─────────────────────┐
│  cursor-agents (BullMQ)                  │
│  jarek-va (Sidekiq)                      │
│  Other applications                      │
└─────────────────────────────────────────┘
```

## Development

### Project Structure

```
cursor-agents/
├── src/
│   ├── index.ts              # Application entry point
│   ├── app.ts                 # Express app setup
│   ├── logger.ts              # Winston logger configuration
│   └── queue/
│       ├── queue-manager.ts    # BullMQ queue management
│       └── prompt-processor.ts # Prompt processing logic
├── dist/                      # Compiled JavaScript (generated)
├── package.json
├── tsconfig.json
├── Dockerfile
└── docker-compose.yml
```

### Scripts

- `npm run build` - Build TypeScript to JavaScript
- `npm run build:watch` - Watch mode for building
- `npm run dev` - Start in development mode with hot reload
- `npm start` - Start application (requires build first)
- `npm run lint` - Run ESLint
- `npm run format` - Format code with Prettier
- `npm test` - Run tests (when implemented)

## Integration with Other Services

### Shared Redis

cursor-agents uses the same Redis instance as:
- **jarek-va**: For Sidekiq job queues
- **Other services**: For caching and other Redis operations

The Redis connection is configured via the `REDIS_URL` environment variable:
- **Docker**: `redis://redis:6379/0` (uses Docker service name)
- **Local**: `redis://localhost:6379/0`

### Cursor Runner Integration

The `PromptProcessor` can be extended to call the cursor-runner API for executing prompts. See `src/queue/prompt-processor.ts` for the TODO implementation.

## Troubleshooting

### Redis Connection Issues

1. **Verify Redis container is running**: `docker-compose ps`
2. **Check Redis logs**: `docker-compose logs redis`
3. **Ensure network connectivity**: Ensure `virtual-assistant-network` exists
4. **Check REDIS_URL**: Verify it's set to `redis://redis:6379/0` in Docker

### Queue Not Processing

1. **Check worker logs**: `docker-compose logs cursor-agents`
2. **Verify Redis connection**: Check application startup logs
3. **Check queue status**: Use `GET /queues` endpoint
4. **Verify schedule**: Check cron pattern or repeat options

## License

ISC

