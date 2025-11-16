#!/bin/bash
set -e

echo "=========================================="
echo "Manual Tool Copy Script"
echo "=========================================="

# Check if cursor-agents container is running
if ! docker ps | grep -q cursor-agents; then
  echo "Error: cursor-agents container is not running"
  echo "Please start it with: docker-compose up -d cursor-agents"
  exit 1
fi

echo "✓ cursor-agents container is running"

# Copy tools from container to shared volume
echo ""
echo "Copying tools from container to shared volume..."
echo "Source: /app/tools (inside container)"
echo "Destination: /cursor/tools/cursor-agents/ (on shared volume)"

# Execute the copy command inside the container
docker exec cursor-agents sh -c '
  if [ -d "/cursor" ]; then
    echo "✓ /cursor volume is mounted"
    
    # Verify source directory exists
    if [ ! -d "/app/tools" ]; then
      echo "ERROR: /app/tools directory does not exist in container!"
      exit 1
    fi
    
    if [ -z "$(ls -A /app/tools)" ]; then
      echo "ERROR: /app/tools directory is empty!"
      exit 1
    fi
    
    echo "Source tools found: $(ls -1 /app/tools | wc -l) files"
    echo "Files: $(ls -1 /app/tools | tr '\n' ' ')"
    
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
    
    echo ""
    echo "✓ Tools copied successfully to /cursor/tools/cursor-agents/"
    echo "Copied files: $(ls -1 /cursor/tools/cursor-agents | wc -l) files"
    echo "Files: $(ls -1 /cursor/tools/cursor-agents | tr '\n' ' ')"
  else
    echo "ERROR: /cursor volume is not mounted in container!"
    exit 1
  fi
'

if [ $? -eq 0 ]; then
  echo ""
  echo "=========================================="
  echo "✓ Copy completed successfully!"
  echo "=========================================="
  echo ""
  echo "You can verify the files are accessible by running:"
  echo "  docker exec cursor-runner ls -la /cursor/tools/cursor-agents/"
  echo ""
  echo "Or test a script directly:"
  echo "  docker exec cursor-runner python3 /cursor/tools/cursor-agents/list_agents.py"
else
  echo ""
  echo "=========================================="
  echo "✗ Copy failed!"
  echo "=========================================="
  exit 1
fi

