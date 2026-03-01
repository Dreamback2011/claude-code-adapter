/**
 * Health Check — OpenClaw 健康检查
 *
 * 检查各组件状态：
 * 1. TypeScript 编译
 * 2. Adapter 服务可达
 * 3. 核心文件完整性
 * 4. Git 状态
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

function exec(cmd: string, timeout = 30000): string {
  try {
    return execSync(cmd, { encoding: "utf-8", cwd: process.cwd(), timeout }).trim();
  } catch (e: any) {
    return `ERROR: ${e.message}`;
  }
}

export interface CheckResult {
  name: string;
  status: "pass" | "fail" | "warn";
  message: string;
}

export interface HealthResult {
  overall: "pass" | "fail" | "warn";
  checks: CheckResult[];
  timestamp: string;
}

/**
 * Check TypeScript compilation
 */
function checkTypeScript(): CheckResult {
  const result = exec("npx tsc --noEmit 2>&1", 60000);
  if (result.startsWith("ERROR:") || result.includes("error TS")) {
    return { name: "typescript", status: "fail", message: result.slice(0, 500) };
  }
  return { name: "typescript", status: "pass", message: "TypeScript compilation OK" };
}

/**
 * Check if adapter server is reachable
 */
function checkAdapter(): CheckResult {
  const result = exec("curl -s -o /dev/null -w '%{http_code}' http://localhost:3456/health", 5000);
  if (result === "200") {
    return { name: "adapter", status: "pass", message: "Adapter health endpoint OK" };
  }
  if (result.startsWith("ERROR:")) {
    return { name: "adapter", status: "warn", message: "Adapter not running (may be expected)" };
  }
  return { name: "adapter", status: "fail", message: `Adapter returned HTTP ${result}` };
}

/**
 * Check core files exist
 */
function checkCoreFiles(): CheckResult {
  const coreFiles = [
    "src/index.ts",
    "src/server.ts",
    "src/adapter.ts",
    "src/claude-cli.ts",
    "src/squad.ts",
    "src/types.ts",
    "package.json",
    "tsconfig.json",
  ];

  const missing = coreFiles.filter((f) => !existsSync(join(process.cwd(), f)));
  if (missing.length > 0) {
    return { name: "core-files", status: "fail", message: `Missing: ${missing.join(", ")}` };
  }
  return { name: "core-files", status: "pass", message: "All core files present" };
}

/**
 * Check git status — are we in a clean state?
 */
function checkGitStatus(): CheckResult {
  const branch = exec("git branch --show-current");
  const status = exec("git status --porcelain");
  const uncommitted = status.split("\n").filter(Boolean).length;

  if (uncommitted > 20) {
    return { name: "git", status: "warn", message: `${uncommitted} uncommitted changes on ${branch}` };
  }
  return {
    name: "git",
    status: "pass",
    message: uncommitted > 0
      ? `On ${branch}, ${uncommitted} uncommitted changes`
      : `On ${branch}, clean working tree`,
  };
}

/**
 * Check npm dependencies
 */
function checkDependencies(): CheckResult {
  if (!existsSync(join(process.cwd(), "node_modules"))) {
    return { name: "dependencies", status: "fail", message: "node_modules missing — run npm install" };
  }
  return { name: "dependencies", status: "pass", message: "node_modules present" };
}

/**
 * Run all health checks
 */
export function runHealthCheck(): HealthResult {
  const checks: CheckResult[] = [
    checkCoreFiles(),
    checkDependencies(),
    checkGitStatus(),
    checkTypeScript(),
    checkAdapter(),
  ];

  const hasFail = checks.some((c) => c.status === "fail");
  const hasWarn = checks.some((c) => c.status === "warn");

  return {
    overall: hasFail ? "fail" : hasWarn ? "warn" : "pass",
    checks,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Quick health check — skip slow checks (TypeScript compilation)
 */
export function runQuickHealthCheck(): HealthResult {
  const checks: CheckResult[] = [
    checkCoreFiles(),
    checkDependencies(),
    checkGitStatus(),
    checkAdapter(),
  ];

  const hasFail = checks.some((c) => c.status === "fail");
  const hasWarn = checks.some((c) => c.status === "warn");

  return {
    overall: hasFail ? "fail" : hasWarn ? "warn" : "pass",
    checks,
    timestamp: new Date().toISOString(),
  };
}
