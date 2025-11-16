#!/usr/bin/env python3
"""
Enable Task Operator Tool

Enables the task operator agent, which automatically processes tasks from the database.
The task operator will continuously check for incomplete tasks and send them to cursor-runner
until disabled.

Usage:
    python enable_task_operator.py [--queue <queue-name>]

Optional Arguments:
    --queue, -q              Queue name to use for the task operator (default: "task-operator")
    --help, -h               Show this help message

Examples:
    # Enable task operator with default queue
    python enable_task_operator.py

    # Enable task operator in a specific queue
    python enable_task_operator.py --queue "task-processing"
"""

import argparse
import json
import os
import sys
from typing import Any, Dict
import urllib.request
import urllib.error


def make_request(url: str, method: str = 'POST', data: Dict[str, Any] = None) -> Dict[str, Any]:
    """Make HTTP request to cursor-agents API."""
    try:
        if data:
            data_bytes = json.dumps(data).encode('utf-8')
        else:
            data_bytes = None

        req = urllib.request.Request(
            url,
            data=data_bytes,
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
        description="Enable the task operator agent",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )

    parser.add_argument(
        '--queue', '-q',
        default='task-operator',
        help='Queue name to use for the task operator (default: "task-operator")'
    )

    args = parser.parse_args()

    # Get API URL from environment or use default
    api_url = os.getenv('CURSOR_AGENTS_URL', 'http://cursor-agents:3002')
    url = f"{api_url}/task-operator"

    # Build request body
    body = {}
    if args.queue:
        body['queue'] = args.queue

    # Make HTTP request to enable task operator
    result = make_request(url, method='POST', data=body)

    if 'error' in result:
        print(f"Error: {result['error']}", file=sys.stderr)
        sys.exit(1)

    # Print success message
    print(json.dumps(result, indent=2, default=str))


if __name__ == '__main__':
    main()

