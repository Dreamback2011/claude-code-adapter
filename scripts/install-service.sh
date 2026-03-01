#!/bin/bash
# 企业微信托管服务 — 安装/卸载/状态管理
# 用法: bash install-service.sh {install|uninstall|status|restart|logs}

PROJECT_DIR="/Users/dreamback/claude-mcp-cli"
LOG_DIR="$PROJECT_DIR/logs"
ADAPTER_PLIST="$HOME/Library/LaunchAgents/com.claude-adapter.plist"
NGROK_PLIST="$HOME/Library/LaunchAgents/com.dreamback.ngrok-wecom.plist"

do_install() {
  echo "=== 安装企业微信 24/7 托管服务 ==="

  # 创建日志目录
  mkdir -p "$LOG_DIR"

  # 先停掉可能正在运行的旧服务
  launchctl unload "$ADAPTER_PLIST" 2>/dev/null
  launchctl unload "$NGROK_PLIST" 2>/dev/null

  # 杀掉现有进程
  lsof -ti:3456 | xargs kill 2>/dev/null
  pkill -f "ngrok http 3456" 2>/dev/null
  sleep 1

  # 加载服务
  echo "加载 ngrok 隧道服务..."
  launchctl load "$NGROK_PLIST"
  sleep 3  # 等 ngrok 启动完成

  echo "加载适配器服务..."
  launchctl load "$ADAPTER_PLIST"
  sleep 2

  echo ""
  do_status
  echo ""
  echo "=== 安装完成 ==="
  echo "服务已设为开机自启动 + 崩溃自动重启"
  echo "日志目录: $LOG_DIR/"
}

do_uninstall() {
  echo "=== 卸载企业微信托管服务 ==="

  launchctl unload "$ADAPTER_PLIST" 2>/dev/null
  launchctl unload "$NGROK_PLIST" 2>/dev/null

  # 确保进程被杀掉
  lsof -ti:3456 | xargs kill 2>/dev/null
  pkill -f "ngrok http 3456" 2>/dev/null

  echo "服务已卸载（开机不再自启动）"
}

do_status() {
  echo "--- 服务状态 ---"

  # 检查适配器
  local adapter_pid
  adapter_pid=$(lsof -ti:3456 2>/dev/null)
  if [ -n "$adapter_pid" ]; then
    echo "适配器: 运行中 (PID: $adapter_pid, Port: 3456)"
    local health
    health=$(curl -s http://127.0.0.1:3456/health 2>/dev/null)
    [ -n "$health" ] && echo "  健康检查: $health"
  else
    echo "适配器: 未运行"
  fi

  # 检查 ngrok
  local ngrok_pid
  ngrok_pid=$(pgrep -f "ngrok http 3456" 2>/dev/null)
  if [ -n "$ngrok_pid" ]; then
    echo "ngrok: 运行中 (PID: $ngrok_pid)"
    local tunnel_url
    tunnel_url=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['tunnels'][0]['public_url'])" 2>/dev/null)
    [ -n "$tunnel_url" ] && echo "  公网地址: $tunnel_url"
    [ -n "$tunnel_url" ] && echo "  企微回调: ${tunnel_url}/wecom/callback"
  else
    echo "ngrok: 未运行"
  fi
}

do_restart() {
  echo "=== 重启服务 ==="
  launchctl unload "$ADAPTER_PLIST" 2>/dev/null
  launchctl unload "$NGROK_PLIST" 2>/dev/null
  lsof -ti:3456 | xargs kill 2>/dev/null
  pkill -f "ngrok http 3456" 2>/dev/null
  sleep 2

  launchctl load "$NGROK_PLIST"
  sleep 3
  launchctl load "$ADAPTER_PLIST"
  sleep 2

  do_status
}

do_logs() {
  echo "--- 最近日志 (适配器) ---"
  [ -f "$LOG_DIR/adapter.log" ] && tail -30 "$LOG_DIR/adapter.log" || echo "暂无日志"
  echo ""
  echo "--- 最近日志 (ngrok) ---"
  [ -f "$LOG_DIR/ngrok.log" ] && tail -10 "$LOG_DIR/ngrok.log" || echo "暂无日志"
}

case "${1:-}" in
  install)   do_install ;;
  uninstall) do_uninstall ;;
  status)    do_status ;;
  restart)   do_restart ;;
  logs)      do_logs ;;
  *)
    echo "企业微信 24/7 托管服务管理"
    echo "用法: $0 {install|uninstall|status|restart|logs}"
    echo ""
    echo "  install   — 安装并启动服务（开机自启 + 崩溃重启）"
    echo "  uninstall — 停止并卸载服务"
    echo "  status    — 查看运行状态"
    echo "  restart   — 重启所有服务"
    echo "  logs      — 查看最近日志"
    exit 1
    ;;
esac
