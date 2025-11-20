#!/usr/bin/env python3
"""
Disable Task Operator Tool

Disables the task operator agent by setting the system setting to false.
The task operator will stop re-enqueueing itself after current jobs complete.

Usage:
    python disable_task_operator.py

Examples:
    # Disable task operator
    python disable_task_operator.py
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
        description="Disable the task operator agent",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )

    args = parser.parse_args()

    # Get API URL from environment or use default
    api_url = os.getenv('CURSOR_AGENTS_URL', 'http://cursor-agents:3002')
    url = f"{api_url}/task-operator"

    # Make HTTP request to disable task operator
    result = make_request(url, method='DELETE')

    if 'error' in result:
        print(f"Error: {result['error']}", file=sys.stderr)
        sys.exit(1)

    # Print success message
    print(json.dumps(result, indent=2, default=str))


if __name__ == '__main__':
    main()





