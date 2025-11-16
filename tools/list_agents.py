#!/usr/bin/env python3
"""
List Agents Tool

Lists all active agents in the cursor-agents system.

Usage:
    python list_agents.py

This tool has no arguments. It simply lists all active agents and their status.

Output:
    Returns a JSON array of agent objects, each containing:
    - name: Agent name
    - isActive: Whether the agent is currently active
    - lastRun: Last execution time (if available)
    - nextRun: Next scheduled execution time (if available)
    - targetUrl: Target URL for the agent
    - method: HTTP method used
    - schedule: Cron pattern or interval (for recurring agents)
    - timeout: Request timeout in milliseconds

Example Output:
    {
      "agents": [
        {
          "name": "daily-check",
          "isActive": true,
          "lastRun": "2024-01-15T10:00:00Z",
          "nextRun": "2024-01-16T10:00:00Z",
          "targetUrl": "http://api.example.com/check",
          "method": "GET",
          "schedule": "0 0 * * *",
          "timeout": 30000
        }
      ]
    }

Note:
    This script outputs the expected format.
    To actually list agents, you would need to:
    1. Use the cursor-agents MCP server's list_agents tool
    2. Or make an HTTP request to the cursor-agents API
"""

import json
import os
import sys
import urllib.request
import urllib.error


def make_request(url: str) -> dict:
    """Make HTTP request to cursor-agents API."""
    request = urllib.request.Request(url)
    
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        error_body = e.read().decode('utf-8')
        try:
            error_data = json.loads(error_body)
            return {'error': error_data.get('error', error_body), 'status': e.code}
        except json.JSONDecodeError:
            return {'error': error_body, 'status': e.code}
    except Exception as e:
        return {'error': str(e)}


def main():
    """Main entry point."""
    # Get API URL from environment or use default
    api_url = os.getenv('CURSOR_AGENTS_URL', 'http://cursor-agents:3002')
    url = f"{api_url}/agents"
    
    # Make HTTP request to list agents
    result = make_request(url)
    
    if 'error' in result:
        print(json.dumps(result, indent=2), file=sys.stderr)
        sys.exit(1)
    
    # Output the result
    print(json.dumps(result, indent=2, default=str))


if __name__ == '__main__':
    main()

