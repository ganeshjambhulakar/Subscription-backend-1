#!/bin/bash

# Restart backend server script

echo "🔄 Restarting backend server..."

# Find and kill existing server
PID=$(lsof -ti:3001)
if [ ! -z "$PID" ]; then
  echo "Stopping existing server (PID: $PID)..."
  kill -9 $PID
  sleep 2
fi

# Start server
echo "Starting server..."
cd "$(dirname "$0")"
npm start


