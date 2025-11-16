#!/bin/sh
set -e

# Copy tools to shared volume if it's mounted
# Do a full replace: remove existing directory and copy fresh
if [ -d "/cursor" ]; then
  echo "Copying tools to shared volume (full replace)..."
  
  # Verify source directory exists and has content
  if [ ! -d "/app/tools" ]; then
    echo "ERROR: /app/tools directory does not exist in container!"
    exit 1
  fi
  
  if [ -z "$(ls -A /app/tools)" ]; then
    echo "ERROR: /app/tools directory is empty!"
    exit 1
  fi
  
  echo "Source tools found: $(ls -1 /app/tools | wc -l) files"
  
  # Remove existing tools directory to ensure clean copy
  rm -rf /cursor/tools/cursor-agents
  # Create directory and copy all tools
  mkdir -p /cursor/tools/cursor-agents
  
  # Copy tools with verbose output
  cp -rv /app/tools/* /cursor/tools/cursor-agents/
  
  # Set executable permissions on Python scripts
  chmod +x /cursor/tools/cursor-agents/*.py 2>/dev/null || true
  
  # Verify copy was successful
  if [ -z "$(ls -A /cursor/tools/cursor-agents)" ]; then
    echo "ERROR: Tools copy failed - destination directory is empty!"
    exit 1
  fi
  
  echo "Tools copied successfully to /cursor/tools/cursor-agents/ (full replace completed)"
  echo "Copied files: $(ls -1 /cursor/tools/cursor-agents | wc -l) files"
else
  echo "Warning: /cursor volume not mounted, skipping tool copy"
fi

# Execute the main command
exec "$@"

