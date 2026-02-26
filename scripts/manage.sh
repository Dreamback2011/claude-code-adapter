#!/bin/bash
# Claude Code Adapter 服务管理脚本
# 用法: bash manage.sh {start|stop|restart|status|logs}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$PROJECT_DIR/.adapter.pid"
LOG_FILE="$PROJECT_DIR/.adapter.log"

# 从 .env 读取端口，默认 3456
PORT=$(grep -E '^PORT=' "$PROJECT_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d ' ')
PORT=${PORT:-3456}

get_pid() {
  lsof -ti:"$PORT" 2>/dev/null
}

do_start() {
  local existing_pid
  existing_pid=$(get_pid)
  if [ -n "$existing_pid" ]; then
    echo "Adapter 已在运行 (PID: $existing_pid, Port: $PORT)"
    return 0
  fi

  echo "启动 Claude Code Adapter (Port: $PORT)..."
  cd "$PROJECT_DIR" || exit 1

  # Clean Claude-related env vars to prevent nested session issues
  unset CLAUDECODE CLAUDE_DEV 2>/dev/null
  for var in $(env | grep -oE '^CLAUDE_(CODE|AGENT)_[^=]+'); do
    unset "$var" 2>/dev/null
  done

  nohup npx tsx src/index.ts > "$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"
  sleep 2

  if kill -0 "$pid" 2>/dev/null; then
    echo "启动成功 (PID: $pid)"
    echo "日志: $LOG_FILE"
  else
    echo "启动失败，查看日志:"
    tail -20 "$LOG_FILE"
    return 1
  fi
}

do_stop() {
  local pid
  pid=$(get_pid)
  if [ -z "$pid" ]; then
    echo "Adapter 未在运行"
    rm -f "$PID_FILE"
    return 0
  fi

  echo "停止 Adapter (PID: $pid)..."
  kill "$pid" 2>/dev/null
  sleep 1

  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null
    sleep 1
  fi

  rm -f "$PID_FILE"
  echo "已停止"
}

do_status() {
  local pid
  pid=$(get_pid)
  if [ -n "$pid" ]; then
    echo "Adapter 运行中 (PID: $pid, Port: $PORT)"
    curl -s "http://127.0.0.1:$PORT/health" 2>/dev/null && echo ""
  else
    echo "Adapter 未运行"
  fi
}

do_logs() {
  if [ -f "$LOG_FILE" ]; then
    tail -50 "$LOG_FILE"
  else
    echo "暂无日志文件"
  fi
}

case "${1:-}" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop; sleep 1; do_start ;;
  status)  do_status ;;
  logs)    do_logs ;;
  *)
    echo "用法: $0 {start|stop|restart|status|logs}"
    exit 1
    ;;
esac
