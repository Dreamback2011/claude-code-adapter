#!/bin/bash
# Wrapper script for launchd — starts the adapter server with clean env
# Prevents nested Claude session hang by removing conflicting env vars

cd /Users/dreamback/claude-mcp-cli || exit 1

# Clean Claude-related env vars to prevent nested session issues
unset CLAUDECODE CLAUDE_DEV 2>/dev/null
for var in $(env | grep -oE '^CLAUDE_(CODE|AGENT)_[^=]+'); do
  unset "$var" 2>/dev/null
done

export NODE_OPTIONS="--max-old-space-size=192"
exec /opt/homebrew/bin/npx tsx src/index.ts
