#!/bin/bash
# Deploy LINE Webhook script
# Usage: ./deploy.sh [target-directory]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${1:-./line-webhook-bot}"

echo "=== LINE Webhook Deployment ==="
echo "Source: $SCRIPT_DIR"
echo "Target: $TARGET_DIR"

# Copy template
echo "[1/4] Copying template..."
mkdir -p "$TARGET_DIR"
cp -r "$SCRIPT_DIR/../assets/line-webhook-template"/* "$TARGET_DIR/"

# Setup environment
echo "[2/4] Setting up environment..."
if [ ! -f "$TARGET_DIR/.env" ]; then
    cp "$TARGET_DIR/.env.example" "$TARGET_DIR/.env"
    echo "✓ Created .env file - Please edit it with your credentials"
else
    echo "✓ .env already exists, keeping existing configuration"
fi

# Create necessary directories
echo "[3/4] Creating directories..."
mkdir -p "$TARGET_DIR/knowledge" "$TARGET_DIR/logs"
touch "$TARGET_DIR/knowledge/.gitkeep" "$TARGET_DIR/logs/.gitkeep"

echo "[4/4] Done!"
echo ""
echo "Next steps:"
echo "1. cd $TARGET_DIR"
echo "2. Edit .env with your credentials"
echo "3. docker-compose up -d"
echo "4. curl http://localhost:4040/api/tunnels  # Get webhook URL"
echo ""
