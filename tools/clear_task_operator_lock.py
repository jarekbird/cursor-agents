#!/usr/bin/env python3
"""
Clear Task Operator Lock Tool

Forcefully clears the Redis lock used by the task operator.
This is useful when the lock is stuck (e.g., after a crash) and preventing
the task operator from processing new tasks.

WARNING: Only use this if you're sure no task is currently being processed,
as clearing the lock while a task is in progress could cause issues.

Usage:
    python clear_task_operator_lock.py

Examples:
    # Clear the task operator Redis lock
    python clear_task_operator_lock.py
"""

import argparse
import json
import os
import sys
from typing import Any, Dict
import urllib.request
import urllib.error


def make_request(url: str, method: str = 'DELETE') -> Dict[str, Any]:
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
        description="Clear the task operator Redis lock",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )

    args = parser.parse_args()

    # Get API URL from environment or use default
    api_url = os.getenv('CURSOR_AGENTS_URL', 'http://cursor-agents:3002')
    url = f"{api_url}/task-operator/lock"

    # Make HTTP request to clear the lock
    result = make_request(url, method='DELETE')

    if 'error' in result:
        print(f"Error: {result['error']}", file=sys.stderr)
        sys.exit(1)

    # Print success message
    print(json.dumps(result, indent=2, default=str))


if __name__ == '__main__':
    main()


