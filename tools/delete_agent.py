#!/usr/bin/env python3
"""
Delete Agent Tool

Deletes/removes an agent from the cursor-agents system.

Usage:
    python delete_agent.py --name <agent-name>

Required Arguments:
    --name, -n              Name of the agent to delete

Output:
    Returns a JSON object indicating success:
    {
      "success": true,
      "message": "Agent \"agent-name\" deleted successfully"
    }

Example:
    python delete_agent.py --name "daily-check"

Example Output:
    {
      "success": true,
      "message": "Agent \"daily-check\" deleted successfully"
    }

Note:
    This script outputs the expected format.
    To actually delete an agent, you would need to:
    1. Use the cursor-agents MCP server's delete_agent tool
    2. Or make an HTTP request to the cursor-agents API

Warning:
    Deleting an agent will stop all scheduled executions and remove the agent
    from the system. This action cannot be undone.
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
        description="Delete/remove an agent from the cursor-agents system",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    
    parser.add_argument(
        '--name', '-n',
        required=True,
        help='Name of the agent to delete'
    )
    
    return parser.parse_args()


def make_request(url: str, method: str = 'GET') -> dict:
    """Make HTTP request to cursor-agents API."""
    request = urllib.request.Request(url, method=method)
    
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
    
    # Make HTTP request to delete agent
    result = make_request(url, method='DELETE')
    
    if 'error' in result:
        print(json.dumps(result, indent=2), file=sys.stderr)
        sys.exit(1)
    
    # Output the result
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()

