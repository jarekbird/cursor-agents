# Cursor-Agents Tool Scripts

This directory contains Python scripts that provide command-line interfaces for each MCP tool available in the cursor-agents application.

## Available Tools

### create_agent.py
Creates a new agent (BullMQ job) that makes HTTP requests to a target URL. Can be one-time or recurring.

**Usage:**
```bash
python create_agent.py --name <name> --target-url <url> [options]
```

**Options:**
- `--name, -n`: Unique name for the agent (required)
- `--target-url, -u`: Target URL to hit (required)
- `--method, -m`: HTTP method (GET, POST, PUT, DELETE, PATCH, default: POST)
- `--headers, -H`: HTTP headers as JSON object (default: {})
- `--body, -b`: Request body as JSON string
- `--schedule, -s`: Cron pattern or interval (required if --one-time is false)
- `--one-time, -o`: Run once immediately (default: false)
- `--timeout, -t`: Request timeout in milliseconds (default: 30000)
- `--queue, -q`: Queue name (defaults to "default" if not specified)

**Examples:**
```bash
# Create a one-time agent in default queue
python create_agent.py --name "test-agent" --target-url "http://cursor-runner:3001/health" --one-time

# Create a recurring agent with cron schedule
python create_agent.py --name "daily-check" --target-url "http://api.example.com/check" \
    --schedule "0 0 * * *" --method GET

# Create an agent in a specific queue
python create_agent.py --name "daily-note" --target-url "http://cursor-runner:3001/cursor/iterate/async" \
    --schedule "0 8 * * *" --queue "daily-tasks" \
    --body '{"prompt": "create todays daily note in the obsidian repository"}'
```

### list_agents.py
Lists all active agents in the cursor-agents system.

**Usage:**
```bash
python list_agents.py
```

**Output:**
Returns a JSON array of agent objects with their status, configuration, and queue information.

### get_agent_status.py
Gets the status of a specific agent by name.

**Usage:**
```bash
python get_agent_status.py --name <agent-name>
```

**Output:**
Returns detailed information about the agent including status, schedule, queue, and configuration.

### delete_agent.py
Deletes/removes an agent from the cursor-agents system.

**Usage:**
```bash
python delete_agent.py --name <agent-name>
```

### list_queues.py
Lists all available queues with their statistics and agent lists.

**Usage:**
```bash
python list_queues.py
```

**Output:**
Returns a JSON array of queue objects, each containing:
- Queue name
- Job counts (waiting, active, completed, failed, delayed)
- List of agents in the queue

### get_queue_info.py
Gets detailed information about a specific queue.

**Usage:**
```bash
python get_queue_info.py --queue-name <queue-name>
```

**Output:**
Returns detailed statistics for the specified queue including job counts and agent list.

### delete_queue.py
Deletes an empty queue from the cursor-agents system.

**Usage:**
```bash
python delete_queue.py --queue-name <queue-name>
```

**Restrictions:**
- Cannot delete the "default" queue
- Cannot delete queues that still have jobs
- Empty queues are automatically cleaned up when the last agent is removed

**Output:**
Returns a success message if the queue was deleted, or an error if it cannot be deleted.

### enable_task_operator.py
Enables the task operator agent, which automatically processes tasks from the database.
The task operator will continuously check for incomplete tasks and send them to cursor-runner
until disabled.

**Usage:**
```bash
python enable_task_operator.py [--queue <queue-name>]
```

**Options:**
- `--queue, -q`: Queue name to use for the task operator (default: "task-operator")

**Examples:**
```bash
# Enable task operator with default queue
python enable_task_operator.py

# Enable task operator in a specific queue
python enable_task_operator.py --queue "task-processing"
```

**How it works:**
1. Sets the `task_operator` system setting to `true` in the database
2. Enqueues a task operator agent job
3. The agent will check for incomplete tasks (lowest order first)
4. Sends task prompts to cursor-runner for processing
5. Automatically re-enqueues itself every 5 seconds if still enabled

### disable_task_operator.py
Disables the task operator agent by setting the system setting to false.
The task operator will stop re-enqueueing itself after current jobs complete.

**Usage:**
```bash
python disable_task_operator.py
```

**Examples:**
```bash
# Disable task operator
python disable_task_operator.py
```

**How it works:**
1. Sets the `task_operator` system setting to `false` in the database
2. Removes any existing task operator agents
3. The task operator will stop re-enqueueing after processing current tasks

## Queue Management

Agents can be organized into queues to avoid queue bloat and better organize your agents. By default, agents are created in the `"default"` queue if no queue is specified.

**Benefits of using queues:**
- **Avoid queue bloat**: Group multiple agents into shared queues instead of one queue per agent
- **Better organization**: Organize agents by purpose (e.g., "daily-tasks", "hourly-sync", "urgent")
- **Easier monitoring**: View all agents in a queue together with queue statistics
- **Resource efficiency**: Fewer workers needed when agents share queues

**Queue naming best practices:**
- Use descriptive names: `daily-tasks`, `hourly-sync`, `urgent-jobs`
- Group related agents together
- Use consistent naming conventions across your organization

## Notes

These scripts are primarily documentation and helper tools. They output the expected JSON format for each tool, but to actually interact with the cursor-agents system, you would need to:

1. Use the cursor-agents MCP server tools directly (via cursor-cli or MCP client)
2. Make HTTP requests to the cursor-agents API (if available)
3. Use these scripts as reference for the expected input/output formats

## Deployment

These scripts are automatically copied to `/cursor/tools/cursor-agents/` in the shared Docker volume during deployment, making them available to both cursor-runner and cursor-agents containers.

