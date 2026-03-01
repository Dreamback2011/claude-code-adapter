#!/bin/bash
# Wrapper script for launchd — starts ngrok tunnel for WeCom webhook
# Uses static domain from .env if configured, otherwise falls back to random

PROJECT_DIR="/Users/dreamback/claude-mcp-cli"

# Read NGROK_DOMAIN from .env if set
NGROK_DOMAIN=$(grep -E '^NGROK_DOMAIN=' "$PROJECT_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d ' "'"'"'')

if [ -n "$NGROK_DOMAIN" ]; then
  echo "Starting ngrok with static domain: $NGROK_DOMAIN"
  exec /opt/homebrew/bin/ngrok http 3456 --domain="$NGROK_DOMAIN" --log=stdout
else
  echo "WARNING: No NGROK_DOMAIN set in .env — URL will change on restart!"
  echo "Get your free static domain at: https://dashboard.ngrok.com/domains"
  exec /opt/homebrew/bin/ngrok http 3456 --log=stdout
fi
