#!/usr/bin/env python3
"""
Get Queue Info Tool

Gets detailed information about a specific queue.

Usage:
    python get_queue_info.py --queue-name <queue-name>

Required Arguments:
    --queue-name, -q         Name of the queue to get information for

Output:
    Returns a JSON object containing:
    - name: Queue name
    - waiting: Number of waiting jobs
    - active: Number of active jobs
    - completed: Number of completed jobs
    - failed: Number of failed jobs
    - delayed: Number of delayed jobs
    - agents: Array of agent names in this queue

Example:
    python get_queue_info.py --queue-name "default"

Example Output:
    {
      "name": "default",
      "waiting": 0,
      "active": 1,
      "completed": 5,
      "failed": 0,
      "delayed": 2,
      "agents": ["daily-check", "hourly-sync"]
    }

Error Output:
    If the queue is not found, returns:
    {
      "error": "Queue \"queue-name\" not found"
    }

Note:
    This script outputs the expected format.
    To actually get queue info, you would need to:
    1. Use the cursor-agents MCP server's get_queue_info tool
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
        description="Get detailed information about a specific queue",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    
    parser.add_argument(
        '--queue-name', '-q',
        required=True,
        dest='queue_name',
        help='Name of the queue to get information for'
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
    url = f"{api_url}/queues/{args.queue_name}"
    
    # Make HTTP request to get queue info
    result = make_request(url)
    
    if 'error' in result:
        print(json.dumps(result, indent=2), file=sys.stderr)
        sys.exit(1)
    
    # Output the result
    print(json.dumps(result, indent=2, default=str))


if __name__ == '__main__':
    main()




