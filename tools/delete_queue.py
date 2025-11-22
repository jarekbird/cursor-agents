#!/usr/bin/env python3
"""
Delete Queue Tool

Deletes an empty queue from the cursor-agents system.

Usage:
    python delete_queue.py --queue-name <queue-name>

Required Arguments:
    --queue-name, -q         Name of the queue to delete

Output:
    Returns a JSON object indicating success:
    {
      "success": true,
      "message": "Queue \"queue-name\" deleted successfully"
    }

Example:
    python delete_queue.py --queue-name "old-queue"

Example Output:
    {
      "success": true,
      "message": "Queue \"old-queue\" deleted successfully"
    }

Error Output:
    If the queue cannot be deleted, returns an error:
    {
      "error": "Cannot delete queue \"queue-name\" - it still has jobs. Remove all agents first."
    }

Restrictions:
    - Cannot delete the "default" queue
    - Cannot delete queues that still have jobs (waiting, active, delayed, or repeatable)
    - Empty queues are automatically cleaned up when the last agent is removed

Note:
    This script outputs the expected format.
    To actually delete a queue, you would need to:
    1. Use the cursor-agents MCP server's delete_queue tool
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
        description="Delete an empty queue from the cursor-agents system",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    
    parser.add_argument(
        '--queue-name', '-q',
        required=True,
        dest='queue_name',
        help='Name of the queue to delete'
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
    url = f"{api_url}/queues/{args.queue_name}"
    
    # Make HTTP request to delete queue
    result = make_request(url, method='DELETE')
    
    if 'error' in result:
        print(json.dumps(result, indent=2), file=sys.stderr)
        sys.exit(1)
    
    # Output the result
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()






