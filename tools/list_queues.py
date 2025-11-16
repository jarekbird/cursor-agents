#!/usr/bin/env python3
"""
List Queues Tool

Lists all available queues in the cursor-agents system with their statistics.

Usage:
    python list_queues.py

This tool has no arguments. It lists all queues and their information.

Output:
    Returns a JSON object containing an array of queue objects, each containing:
    - name: Queue name
    - waiting: Number of waiting jobs
    - active: Number of active jobs
    - completed: Number of completed jobs
    - failed: Number of failed jobs
    - delayed: Number of delayed jobs
    - agents: Array of agent names in this queue

Example Output:
    {
      "queues": [
        {
          "name": "default",
          "waiting": 0,
          "active": 1,
          "completed": 5,
          "failed": 0,
          "delayed": 2,
          "agents": ["daily-check", "hourly-sync"]
        },
        {
          "name": "daily-tasks",
          "waiting": 0,
          "active": 0,
          "completed": 10,
          "failed": 0,
          "delayed": 1,
          "agents": ["daily-note"]
        }
      ]
    }

Note:
    This script outputs the expected format.
    To actually list queues, you would need to:
    1. Use the cursor-agents MCP server's list_queues tool
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
    url = f"{api_url}/queues"
    
    # Make HTTP request to list queues
    result = make_request(url)
    
    if 'error' in result:
        print(json.dumps(result, indent=2), file=sys.stderr)
        sys.exit(1)
    
    # Output the result
    print(json.dumps(result, indent=2, default=str))


if __name__ == '__main__':
    main()

