#!/usr/bin/env python3
"""
Check Task Operator Lock Tool

Checks whether the task operator currently has a Redis lock.
This is useful to determine if the task operator is currently processing a task.

Usage:
    python check_task_operator_lock.py

Output:
    Returns a JSON object containing:
    - success: Whether the request was successful
    - isLocked: Whether the lock is currently held (true/false)
    - message: Human-readable message about the lock status

Example:
    python check_task_operator_lock.py

Example Output (lock held):
    {
      "success": true,
      "isLocked": true,
      "message": "Task operator Redis lock is currently held"
    }

Example Output (lock not held):
    {
      "success": true,
      "isLocked": false,
      "message": "Task operator Redis lock is not held"
    }

Error Output:
    If there's an error checking the lock, returns:
    {
      "error": "Error message"
    }

Note:
    This script checks the lock status without modifying it.
    To clear a lock, use clear_task_operator_lock.py instead.
"""

import argparse
import json
import os
import sys
from typing import Any, Dict
import urllib.request
import urllib.error


def make_request(url: str, method: str = 'GET') -> Dict[str, Any]:
    """Make HTTP request to cursor-agents API."""
    try:
        req = urllib.request.Request(
            url,
            method=method,
            headers={'Content-Type': 'application/json'}
        )

        with urllib.request.urlopen(req) as response:
            response_data = response.read().decode('utf-8')
            return json.loads(response_data)
    except urllib.error.HTTPError as e:
        error_body = e.read().decode('utf-8')
        try:
            error_data = json.loads(error_body)
            return {'error': error_data.get('error', f'HTTP {e.code}: {error_body}')}
        except json.JSONDecodeError:
            return {'error': f'HTTP {e.code}: {error_body}'}
    except urllib.error.URLError as e:
        return {'error': f'Connection error: {str(e)}'}
    except Exception as e:
        return {'error': str(e)}


def main():
    """Main function."""
    parser = argparse.ArgumentParser(
        description="Check the task operator Redis lock status",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )

    args = parser.parse_args()

    # Get API URL from environment or use default
    api_url = os.getenv('CURSOR_AGENTS_URL', 'http://cursor-agents:3002')
    url = f"{api_url}/task-operator/lock"

    # Make HTTP request to check the lock status
    result = make_request(url, method='GET')

    if 'error' in result:
        print(f"Error: {result['error']}", file=sys.stderr)
        sys.exit(1)

    # Print result
    print(json.dumps(result, indent=2, default=str))


if __name__ == '__main__':
    main()

