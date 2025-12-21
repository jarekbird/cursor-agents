#!/usr/bin/env python3
"""
Create Agent Tool

Creates a new agent (BullMQ job) that makes HTTP requests to a target URL.
Can be one-time or recurring.

Usage:
    python create_agent.py --name <name> --target-url <url> [options]

Required Arguments:
    --name, -n              Unique name for the agent
    --target-url, -u         Target URL to hit (can be public URL or Docker network URL like http://cursor-runner:3001/health)

Optional Arguments:
    --method, -m             HTTP method to use (default: POST)
                            Options: GET, POST, PUT, DELETE, PATCH
    --headers, -H            HTTP headers as JSON object (default: {})
                            Example: '{"Authorization": "Bearer token", "Content-Type": "application/json"}'
    --body, -b               Request body as JSON string (for POST, PUT, PATCH methods)
                            Example: '{"key": "value"}'
    --schedule, -s           Cron pattern (e.g., "0 */5 * * * *" for every 5 minutes) or interval
                            Required if --one-time is false
    --one-time, -o             If true, run the agent once immediately (default: false)
    --timeout, -t              Request timeout in milliseconds (default: 30000)
    --queue, -q                Queue name to use for this agent (defaults to "default" if not specified)
    --help, -h                 Show this help message

Examples:
    # Create a one-time agent
    python create_agent.py --name "test-agent" --target-url "http://cursor-runner:3001/health" --one-time

    # Create a recurring agent with cron schedule
    python create_agent.py --name "daily-check" --target-url "http://api.example.com/check" \\
        --schedule "0 0 * * *" --method GET

    # Create an agent with headers and body
    python create_agent.py --name "api-sync" --target-url "http://api.example.com/sync" \\
        --method POST --headers '{"Authorization": "Bearer token"}' \\
        --body '{"action": "sync"}' --schedule "0 */30 * * * *"

    # Create an agent in a specific queue
    python create_agent.py --name "daily-note" --target-url "http://cursor-runner:3001/cursor/execute/async" \\
        --schedule "0 8 * * *" --queue "daily-tasks" \\
        --body '{"prompt": "create todays daily note in the obsidian repository"}'
"""

import argparse
import json
import os
import sys
from typing import Any, Dict
import urllib.request
import urllib.error


def parse_arguments() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Create a new agent (BullMQ job) that makes HTTP requests to a target URL",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    
    # Required arguments
    parser.add_argument(
        '--name', '-n',
        required=True,
        help='Unique name for the agent'
    )
    parser.add_argument(
        '--target-url', '-u',
        required=True,
        dest='target_url',
        help='Target URL to hit (can be public URL or Docker network URL)'
    )
    
    # Optional arguments
    parser.add_argument(
        '--method', '-m',
        choices=['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
        default='POST',
        help='HTTP method to use (default: POST)'
    )
    parser.add_argument(
        '--headers', '-H',
        default='{}',
        help='HTTP headers as JSON object (default: {})'
    )
    parser.add_argument(
        '--body', '-b',
        help='Request body as JSON string (for POST, PUT, PATCH methods)'
    )
    parser.add_argument(
        '--schedule', '-s',
        help='Cron pattern (e.g., "0 */5 * * * *" for every 5 minutes) or interval. Required if --one-time is false'
    )
    parser.add_argument(
        '--one-time', '-o',
        action='store_true',
        default=False,
        help='If true, run the agent once immediately (default: false)'
    )
    parser.add_argument(
        '--timeout', '-t',
        type=int,
        default=30000,
        help='Request timeout in milliseconds (default: 30000)'
    )
    parser.add_argument(
        '--queue', '-q',
        help='Queue name to use for this agent (defaults to "default" if not specified)'
    )
    
    return parser.parse_args()


def validate_arguments(args: argparse.Namespace) -> None:
    """Validate that required combinations of arguments are present."""
    if not args.one_time and not args.schedule:
        print("Error: Either --one-time must be true or --schedule must be provided", file=sys.stderr)
        sys.exit(1)
    
    # Validate headers JSON
    try:
        headers = json.loads(args.headers)
        if not isinstance(headers, dict):
            raise ValueError("Headers must be a JSON object")
    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON in --headers: {e}", file=sys.stderr)
        sys.exit(1)
    
    # Validate body JSON if provided
    if args.body:
        try:
            json.loads(args.body)
        except json.JSONDecodeError as e:
            print(f"Error: Invalid JSON in --body: {e}", file=sys.stderr)
            sys.exit(1)


def build_agent_config(args: argparse.Namespace) -> Dict[str, Any]:
    """Build the agent configuration dictionary."""
    config: Dict[str, Any] = {
        'name': args.name,
        'targetUrl': args.target_url,
        'method': args.method,
        'headers': json.loads(args.headers),
        'oneTime': args.one_time,
        'timeout': args.timeout,
    }
    
    if args.body:
        config['body'] = json.loads(args.body)
    
    if not args.one_time and args.schedule:
        config['schedule'] = args.schedule
    
    if args.queue:
        config['queue'] = args.queue
    
    return config


def make_request(url: str, method: str = 'GET', data: Dict[str, Any] = None) -> Dict[str, Any]:
    """Make HTTP request to cursor-agents API."""
    req_data = None
    if data:
        req_data = json.dumps(data).encode('utf-8')
    
    request = urllib.request.Request(
        url,
        data=req_data,
        headers={'Content-Type': 'application/json'},
        method=method
    )
    
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            response_data = json.loads(response.read().decode('utf-8'))
            return response_data
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
    validate_arguments(args)
    config = build_agent_config(args)
    
    # Get API URL from environment or use default
    api_url = os.getenv('CURSOR_AGENTS_URL', 'http://cursor-agents:3002')
    url = f"{api_url}/agents"
    
    # Make HTTP request to create agent
    result = make_request(url, method='POST', data=config)
    
    if 'error' in result:
        print(json.dumps(result, indent=2), file=sys.stderr)
        sys.exit(1)
    
    # Output the result
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()

