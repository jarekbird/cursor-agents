#!/bin/bash

# Wrapper script to inspect the database schema
# This script can be run locally or in Docker

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Check if running in Docker or locally
if [ -f "/.dockerenv" ] || [ -n "${DOCKER_CONTAINER:-}" ]; then
  # Running in Docker - use default path
  export SHARED_DB_PATH="${SHARED_DB_PATH:-/app/shared_db/shared.sqlite3}"
  echo "Running in Docker environment"
  echo "Database path: $SHARED_DB_PATH"
else
  # Running locally - try to find the database
  if [ -z "${SHARED_DB_PATH:-}" ]; then
    # Try the local mount point first
    LOCAL_DB="${HOME}/.virtual-assistant/shared-db/shared.sqlite3"
    if [ -f "$LOCAL_DB" ]; then
      export SHARED_DB_PATH="$LOCAL_DB"
      echo "Found database at local mount point: $SHARED_DB_PATH"
    else
      echo "⚠️  Database not found at default location: $LOCAL_DB"
      echo ""
      echo "Options:"
      echo "1. Set SHARED_DB_PATH environment variable:"
      echo "   export SHARED_DB_PATH=/path/to/shared.sqlite3"
      echo "   $0"
      echo ""
      echo "2. Run the access script to mount the database:"
      echo "   cd ../cursor-runner && ./scripts/access-shared-db.sh"
      echo ""
      echo "3. Run inside Docker container:"
      echo "   docker-compose exec cursor-agents npm run inspect:db"
      echo ""
      exit 1
    fi
  else
    echo "Using SHARED_DB_PATH: $SHARED_DB_PATH"
  fi
fi

echo ""
cd "$PROJECT_DIR"

# Run the TypeScript script
if command -v tsx >/dev/null 2>&1; then
  tsx scripts/inspect-db-schema.ts
else
  echo "tsx not found. Building and running compiled version..."
  npm run build
  node dist/scripts/inspect-db-schema.js
fi







