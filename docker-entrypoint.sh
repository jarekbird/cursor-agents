#!/bin/sh
set -e

# Copy tools to shared volume if it's mounted
# ALWAYS do a full replace: remove existing directory and copy fresh on every container start
if [ -d "/cursor" ]; then
  echo "=========================================="
  echo "Copying tools to shared volume (ALWAYS full replace)"
  echo "=========================================="
  
  # Verify source directory exists and has content
  if [ ! -d "/app/tools" ]; then
    echo "ERROR: /app/tools directory does not exist in container!"
    exit 1
  fi
  
  if [ -z "$(ls -A /app/tools)" ]; then
    echo "ERROR: /app/tools directory is empty!"
    exit 1
  fi
  
  SOURCE_COUNT=$(ls -1 /app/tools | wc -l)
  echo "Source tools found: $SOURCE_COUNT files"
  
  # Check if destination exists and show what will be replaced
  if [ -d "/cursor/tools/cursor-agents" ]; then
    EXISTING_COUNT=$(ls -1 /cursor/tools/cursor-agents 2>/dev/null | wc -l || echo "0")
    echo "Existing tools in destination: $EXISTING_COUNT files (will be replaced)"
  else
    echo "Destination directory does not exist (will be created)"
  fi
  
  # ALWAYS remove existing tools directory to ensure clean copy
  # This ensures we always get the latest version from the image
  echo "Removing existing tools directory..."
  rm -rf /cursor/tools/cursor-agents
  
  # Create directory and copy all tools
  echo "Creating destination directory..."
  mkdir -p /cursor/tools/cursor-agents
  
  # Copy tools with verbose output
  echo "Copying tools from /app/tools to /cursor/tools/cursor-agents..."
  cp -rv /app/tools/* /cursor/tools/cursor-agents/
  
  # Set executable permissions on Python scripts
  echo "Setting executable permissions on Python scripts..."
  chmod +x /cursor/tools/cursor-agents/*.py 2>/dev/null || true
  
  # Verify copy was successful
  DEST_COUNT=$(ls -1 /cursor/tools/cursor-agents 2>/dev/null | wc -l || echo "0")
  if [ "$DEST_COUNT" -eq "0" ]; then
    echo "ERROR: Tools copy failed - destination directory is empty!"
    exit 1
  fi
  
  echo "=========================================="
  echo "✓ Tools copied successfully (full replace completed)"
  echo "  Source: $SOURCE_COUNT files"
  echo "  Destination: $DEST_COUNT files"
  echo "=========================================="
else
  echo "Warning: /cursor volume not mounted, skipping tool copy"
fi

# Execute the main command
exec "$@"

