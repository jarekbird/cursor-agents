#!/bin/sh
set -e

# Copy tools to shared volume if it's mounted
# Do a full replace: remove existing directory and copy fresh
if [ -d "/cursor" ]; then
  echo "Copying tools to shared volume (full replace)..."
  # Remove existing tools directory to ensure clean copy
  rm -rf /cursor/tools/cursor-agents
  # Create directory and copy all tools
  mkdir -p /cursor/tools/cursor-agents
  cp -r /app/tools/* /cursor/tools/cursor-agents/
  chmod +x /cursor/tools/cursor-agents/*.py
  echo "Tools copied to /cursor/tools/cursor-agents/ (full replace completed)"
else
  echo "Warning: /cursor volume not mounted, skipping tool copy"
fi

# Execute the main command
exec "$@"

