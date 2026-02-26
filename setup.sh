#!/bin/bash
# ============================================================
#  Claude Code Adapter — One-Click Setup
#  自动安装依赖、生成配置、启动服务
# ============================================================

set -e

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
CYAN="\033[36m"
RESET="\033[0m"

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
ENV_EXAMPLE="$PROJECT_DIR/.env.example"

banner() {
  echo ""
  echo -e "${CYAN}${BOLD}"
  echo "  ┌─────────────────────────────────────┐"
  echo "  │   Claude Code Adapter — Setup        │"
  echo "  └─────────────────────────────────────┘"
  echo -e "${RESET}"
}

ok()   { echo -e "  ${GREEN}✔${RESET} $1"; }
warn() { echo -e "  ${YELLOW}⚠${RESET} $1"; }
fail() { echo -e "  ${RED}✘${RESET} $1"; exit 1; }
info() { echo -e "  ${CYAN}ℹ${RESET} $1"; }

# ── Step 0: Banner ──
banner

# ── Step 1: Check prerequisites ──
echo -e "${BOLD}[1/5] Checking prerequisites...${RESET}"

# Node.js
if ! command -v node &>/dev/null; then
  fail "Node.js not found. Install: https://nodejs.org (>= 18)"
fi
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  fail "Node.js >= 18 required (current: $(node -v))"
fi
ok "Node.js $(node -v)"

# npm
if ! command -v npm &>/dev/null; then
  fail "npm not found"
fi
ok "npm $(npm -v)"

# Claude CLI
if ! command -v claude &>/dev/null; then
  fail "Claude Code CLI not found. Install: npm install -g @anthropic-ai/claude-code"
fi
ok "Claude Code CLI found"

# Check Claude auth
if claude auth status 2>&1 | grep -qi "not logged in\|error\|no auth"; then
  warn "Claude CLI may not be authenticated. Run: claude auth login"
else
  ok "Claude CLI authenticated"
fi

# ── Step 2: Install dependencies ──
echo ""
echo -e "${BOLD}[2/5] Installing dependencies...${RESET}"
cd "$PROJECT_DIR"
npm install --silent 2>&1 | tail -1
ok "Dependencies installed"

# ── Step 3: Generate .env ──
echo ""
echo -e "${BOLD}[3/5] Configuring .env...${RESET}"

if [ -f "$ENV_FILE" ]; then
  info "Found existing .env — keeping it"
else
  # Generate a random API key
  RANDOM_KEY="sk-local-$(openssl rand -hex 12)"

  cat > "$ENV_FILE" << EOF
# Local API Key for client authentication
LOCAL_API_KEY=${RANDOM_KEY}

# Server port
PORT=3456

# Claude CLI allowed tools (comma-separated)
ALLOWED_TOOLS=Read,Write,Edit,Bash,Grep,Glob
EOF
  ok "Generated .env with random API key"
fi

# Read config from .env
PORT=$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d ' ')
PORT=${PORT:-3456}
API_KEY=$(grep -E '^LOCAL_API_KEY=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d ' ')

# ── Step 4: Test start ──
echo ""
echo -e "${BOLD}[4/5] Testing server startup...${RESET}"

# Check if port is already in use
if lsof -ti:"$PORT" &>/dev/null; then
  warn "Port $PORT is already in use — an adapter may already be running"
  EXISTING_PID=$(lsof -ti:"$PORT")
  info "PID: $EXISTING_PID"
else
  # Quick start test
  cd "$PROJECT_DIR"
  npx tsx src/index.ts &
  TEST_PID=$!
  sleep 3

  if curl -sf "http://127.0.0.1:$PORT/health" &>/dev/null; then
    ok "Server started successfully on port $PORT"
    kill $TEST_PID 2>/dev/null
    wait $TEST_PID 2>/dev/null
  else
    kill $TEST_PID 2>/dev/null
    wait $TEST_PID 2>/dev/null
    warn "Server test failed — check logs. You can try 'npm start' manually."
  fi
fi

# ── Step 5: Show result ──
echo ""
echo -e "${BOLD}[5/5] Setup complete!${RESET}"
echo ""
echo -e "${GREEN}${BOLD}  ┌─────────────────────────────────────────────────┐${RESET}"
echo -e "${GREEN}${BOLD}  │           ✅  Setup Complete!                    │${RESET}"
echo -e "${GREEN}${BOLD}  ├─────────────────────────────────────────────────┤${RESET}"
echo -e "${GREEN}${BOLD}  │                                                 │${RESET}"
echo -e "${GREEN}${BOLD}  │  Port:     ${PORT}                                │${RESET}"
echo -e "${GREEN}${BOLD}  │  Base URL: http://127.0.0.1:${PORT}               │${RESET}"
echo -e "${GREEN}${BOLD}  │  API Key:  ${API_KEY:0:12}...                    │${RESET}"
echo -e "${GREEN}${BOLD}  │                                                 │${RESET}"
echo -e "${GREEN}${BOLD}  └─────────────────────────────────────────────────┘${RESET}"
echo ""
echo -e "  ${BOLD}Next steps:${RESET}"
echo ""
echo -e "  ${CYAN}1.${RESET} Start the server (keep it running):"
echo -e "     ${BOLD}npm start${RESET}"
echo ""
echo -e "  ${CYAN}2.${RESET} Or run in background:"
echo -e "     ${BOLD}bash scripts/manage.sh start${RESET}"
echo ""
echo -e "  ${CYAN}3.${RESET} Configure OpenClaw custom model:"
echo -e "     ${BOLD}openclaw configure${RESET}"
echo -e "     → Select ${BOLD}Model${RESET}"
echo -e "     → Select ${BOLD}Custom Provider${RESET}"
echo -e "     → Base URL:  ${BOLD}http://127.0.0.1:${PORT}${RESET}"
echo -e "     → API Key:   ${BOLD}${API_KEY}${RESET}"
echo -e "     → Endpoint:  ${BOLD}Anthropic-compatible${RESET}"
echo -e "     → Model ID:  ${BOLD}claude-sonnet-4-6${RESET}"
echo ""
echo -e "  For detailed instructions, see ${BOLD}README.md${RESET}"
echo ""
