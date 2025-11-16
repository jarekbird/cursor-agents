#!/bin/sh
set -e

# Copy tools to shared volume if it's mounted
if [ -d "/cursor" ]; then
  echo "Copying tools to shared volume..."
  mkdir -p /cursor/tools/cursor-agents
  cp -r /app/tools/* /cursor/tools/cursor-agents/
  chmod +x /cursor/tools/cursor-agents/*.py
  echo "Tools copied to /cursor/tools/cursor-agents/"
else
  echo "Warning: /cursor volume not mounted, skipping tool copy"
fi

# Execute the main command
exec "$@"

