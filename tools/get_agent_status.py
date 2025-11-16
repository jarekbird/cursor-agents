#!/usr/bin/env python3
"""
Get Agent Status Tool

Gets the status of a specific agent by name.

Usage:
    python get_agent_status.py --name <agent-name>

Required Arguments:
    --name, -n              Name of the agent to get status for

Output:
    Returns a JSON object containing:
    - name: Agent name
    - isActive: Whether the agent is currently active
    - lastRun: Last execution time (if available)
    - nextRun: Next scheduled execution time (if available)
    - jobId: Job ID (if available)
    - targetUrl: Target URL for the agent
    - method: HTTP method used
    - headers: HTTP headers (if configured)
    - body: Request body (if configured)
    - schedule: Cron pattern or interval (for recurring agents)
    - timeout: Request timeout in milliseconds

Example:
    python get_agent_status.py --name "daily-check"

Example Output:
    {
      "name": "daily-check",
      "isActive": true,
      "lastRun": "2024-01-15T10:00:00Z",
      "nextRun": "2024-01-16T10:00:00Z",
      "jobId": "agent:daily-check",
      "targetUrl": "http://api.example.com/check",
      "method": "GET",
      "headers": {},
      "body": null,
      "schedule": "0 0 * * *",
      "timeout": 30000
    }

Error Output:
    If the agent is not found, returns:
    {
      "error": "Agent \"agent-name\" not found"
    }

Note:
    This script outputs the expected format.
    To actually get agent status, you would need to:
    1. Use the cursor-agents MCP server's get_agent_status tool
    2. Or make an HTTP request to the cursor-agents API
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error


def parse_arguments() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Get the status of a specific agent",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    
    parser.add_argument(
        '--name', '-n',
        required=True,
        help='Name of the agent to get status for'
    )
    
    return parser.parse_args()


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
    args = parse_arguments()
    
    # Get API URL from environment or use default
    api_url = os.getenv('CURSOR_AGENTS_URL', 'http://cursor-agents:3002')
    url = f"{api_url}/agents/{args.name}"
    
    # Make HTTP request to get agent status
    result = make_request(url)
    
    if 'error' in result:
        print(json.dumps(result, indent=2), file=sys.stderr)
        sys.exit(1)
    
    # Output the result
    print(json.dumps(result, indent=2, default=str))


if __name__ == '__main__':
    main()

