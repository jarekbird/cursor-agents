# Cursor-Agents Tool Scripts

This directory contains Python scripts that provide command-line interfaces for each MCP tool available in the cursor-agents application.

## Available Tools

### create_agent.py
Creates a new agent (BullMQ job) that makes HTTP requests to a target URL. Can be one-time or recurring.

**Usage:**
```bash
python create_agent.py --name <name> --target-url <url> [options]
```

**Example:**
```bash
python create_agent.py --name "daily-check" --target-url "http://api.example.com/check" \
    --schedule "0 0 * * *" --method GET
```

### list_agents.py
Lists all active agents in the cursor-agents system.

**Usage:**
```bash
python list_agents.py
```

### get_agent_status.py
Gets the status of a specific agent by name.

**Usage:**
```bash
python get_agent_status.py --name <agent-name>
```

### delete_agent.py
Deletes/removes an agent from the cursor-agents system.

**Usage:**
```bash
python delete_agent.py --name <agent-name>
```

## Notes

These scripts are primarily documentation and helper tools. They output the expected JSON format for each tool, but to actually interact with the cursor-agents system, you would need to:

1. Use the cursor-agents MCP server tools directly (via cursor-cli or MCP client)
2. Make HTTP requests to the cursor-agents API (if available)
3. Use these scripts as reference for the expected input/output formats

## Deployment

These scripts are automatically copied to `/cursor/tools/cursor-agents/` in the shared Docker volume during deployment, making them available to both cursor-runner and cursor-agents containers.

