# MCP Interface for Cursor Agents

This document explains how to use the Model Context Protocol (MCP) interface to manage agents in cursor-agents.

## Overview

The MCP server exposes tools that allow you to create and manage agents. Each agent is a BullMQ job that makes HTTP requests to target URLs (either public URLs or Docker network URLs like `http://cursor-runner:3001/health`).

## Architecture

```
Cursor (IDE) → MCP Server → QueueManager → BullMQ → HTTP Request → Target URL
```

1. **Cursor IDE** connects to the MCP server via stdio
2. **MCP Server** exposes tools for agent management
3. **QueueManager** creates BullMQ jobs for each agent
4. **BullMQ Workers** execute the jobs by making HTTP requests
5. **Target URLs** receive the HTTP requests (can be public or internal Docker network)

## Setup

### 1. Start the MCP Server

The MCP server runs as a separate process that communicates via stdio:

```bash
# Development
npm run start:mcp

# Production
npm run start:mcp:prod
```

### 2. Configure Cursor IDE

Add the MCP server to your Cursor configuration (typically in `~/.cursor/mcp.json` or similar):

```json
{
  "mcpServers": {
    "cursor-agents": {
      "command": "node",
      "args": ["/path/to/cursor-agents/dist/mcp/index.js"],
      "env": {
        "REDIS_URL": "redis://redis:6379/0",
        "NODE_ENV": "production"
      }
    }
  }
}
```

**Note**: In Docker, you may need to run the MCP server inside the container or configure it to connect to the Docker network.

## Available Tools

### 1. `create_agent`

Create a new agent (BullMQ job) that makes HTTP requests to a target URL.

**Parameters:**
- `name` (required): Unique name for the agent
- `targetUrl` (required): Target URL to hit (can be public or Docker network URL)
- `method` (optional): HTTP method (`GET`, `POST`, `PUT`, `DELETE`, `PATCH`), default: `POST`
- `headers` (optional): HTTP headers to include in the request
- `body` (optional): Request body (for POST, PUT, PATCH methods)
- `schedule` (optional): Cron pattern (e.g., `"0 */5 * * * *"` for every 5 minutes) or interval. Required if `oneTime` is false
- `oneTime` (optional): If `true`, run the agent once immediately. If `false`, use `schedule` for recurring execution. Default: `false`
- `timeout` (optional): Request timeout in milliseconds, default: 30000

**Example - One-time agent:**
```json
{
  "name": "health-check-once",
  "targetUrl": "http://cursor-runner:3001/health",
  "method": "GET",
  "oneTime": true
}
```

**Example - Recurring agent:**
```json
{
  "name": "health-check-recurring",
  "targetUrl": "http://cursor-runner:3001/health",
  "method": "GET",
  "schedule": "0 */5 * * * *"
}
```

**Example - POST request with body:**
```json
{
  "name": "cursor-execute-agent",
  "targetUrl": "http://cursor-runner:3001/cursor/execute",
  "method": "POST",
  "headers": {
    "Authorization": "Bearer token123"
  },
  "body": {
    "prompt": "Add a new feature",
    "repository": "my-repo",
    "branchName": "main"
  },
  "schedule": "0 0 * * * *"
}
```

### 2. `list_agents`

List all active agents.

**Parameters:** None

**Returns:** Array of agent status objects

### 3. `get_agent_status`

Get the status of a specific agent.

**Parameters:**
- `name` (required): Name of the agent

**Returns:** Agent status including:
- `name`: Agent name
- `isActive`: Whether the agent is active
- `lastRun`: Last execution time
- `nextRun`: Next scheduled execution time
- `jobId`: BullMQ job ID

### 4. `delete_agent`

Delete/remove an agent.

**Parameters:**
- `name` (required): Name of the agent to delete

## Usage Examples

### Creating a Health Check Agent

Create an agent that checks the health of cursor-runner every 5 minutes:

```json
{
  "tool": "create_agent",
  "arguments": {
    "name": "cursor-runner-health-check",
    "targetUrl": "http://cursor-runner:3001/health",
    "method": "GET",
    "schedule": "0 */5 * * * *"
  }
}
```

### Creating a One-Time Task

Execute a task immediately:

```json
{
  "tool": "create_agent",
  "arguments": {
    "name": "one-time-task",
    "targetUrl": "http://cursor-runner:3001/cursor/execute",
    "method": "POST",
    "body": {
      "prompt": "Fix the bug in the authentication module"
    },
    "oneTime": true
  }
}
```

### Monitoring Agents

```json
{
  "tool": "list_agents"
}
```

```json
{
  "tool": "get_agent_status",
  "arguments": {
    "name": "cursor-runner-health-check"
  }
}
```

## Target URLs

### Public URLs

You can use any public HTTP/HTTPS URL:

```json
{
  "targetUrl": "https://api.example.com/webhook",
  "method": "POST"
}
```

### Docker Network URLs

Within the Docker network, you can use service names:

- `http://cursor-runner:3001/health` - Health check endpoint
- `http://cursor-runner:3001/cursor/execute` - Execute cursor command
- `http://app:3000/api/webhook` - jarek-va webhook endpoint
- `http://redis:6379` - Redis (if it has HTTP interface)

### Localhost URLs

For services running on the same host:

- `http://localhost:3001/health` - Local cursor-runner
- `http://127.0.0.1:3000/api/webhook` - Local jarek-va

## Schedule Formats

### Cron Patterns

Use standard cron syntax (6 fields: second, minute, hour, day, month, weekday):

- `"0 */5 * * * *"` - Every 5 minutes
- `"0 0 * * * *"` - Every hour at minute 0
- `"0 0 0 * * *"` - Every day at midnight
- `"0 0 0 * * 0"` - Every Sunday at midnight

### Interval Patterns (BullMQ)

- `"every 30 seconds"` - Every 30 seconds
- `"every 5 minutes"` - Every 5 minutes
- `"every 1 hour"` - Every hour

## Error Handling

Agents will retry failed requests based on BullMQ's retry configuration. Failed jobs are logged and can be monitored via the agent status.

## Integration with Cursor IDE

Once configured, you can use the MCP tools directly in Cursor:

```
@cursor-agents create_agent name="health-check" targetUrl="http://cursor-runner:3001/health" method="GET" schedule="0 */5 * * * *"
```

Or use the Cursor chat interface to interact with agents naturally.

## Troubleshooting

### MCP Server Not Starting

1. Check Redis connection: Ensure `REDIS_URL` is set correctly
2. Check logs: The MCP server logs to stderr
3. Verify MCP SDK is installed: `npm list @modelcontextprotocol/sdk`

### Agents Not Executing

1. Check agent status: Use `get_agent_status` to see if the agent is active
2. Check BullMQ workers: Ensure workers are running and processing jobs
3. Check Redis connection: Agents require Redis to be accessible
4. Check target URL: Verify the URL is reachable from the Docker network

### HTTP Request Failures

1. Check network connectivity: Ensure the target URL is reachable
2. Check authentication: Verify headers/credentials if required
3. Check timeout: Increase timeout if requests are timing out
4. Check logs: Review agent execution logs for detailed error messages

## Related Documentation

- **BullMQ Documentation**: https://docs.bullmq.io/
- **MCP Protocol**: https://modelcontextprotocol.io/
- **Cursor Agents API**: See `README.md` for REST API endpoints

