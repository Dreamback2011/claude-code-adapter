/**
 * GitHub Updates Agent — CLI Entry Point
 *
 * 可以直接运行：npx tsx agents/github-updates/index.ts <command> [args]
 *
 * Commands:
 *   checkpoint [summary]     — 创建原子提交 + checkpoint
 *   checkpoint list          — 列出最近的 checkpoints
 *   checkpoint status        — 显示当前工作区状态
 *   rollback [checkpoint-id] — 回滚到指定 checkpoint
 *   rollback preview [id]    — 预览回滚会影响什么
 *   health                   — 运行健康检查
 *   health quick             — 快速健康检查（跳过 TypeScript 编译）
 *   diagnose                 — 诊断当前问题
 *   repair                   — 运行自修复流程
 */

import { createCheckpoint, listCheckpoints, getStatus } from "./checkpoint.js";
import { rollbackTo, rollbackFiles, rollbackPreview } from "./rollback.js";
import { runHealthCheck, runQuickHealthCheck } from "./health-check.js";
import { diagnose, repair } from "./self-repair.js";

const [, , command, ...args] = process.argv;

function printJSON(data: any) {
  console.log(JSON.stringify(data, null, 2));
}

async function main() {
  switch (command) {
    case "checkpoint": {
      if (args[0] === "list") {
        const cps = listCheckpoints(parseInt(args[1]) || 10);
        printJSON(cps);
      } else if (args[0] === "status") {
        const status = getStatus();
        printJSON(status);
      } else {
        const summary = args.join(" ") || "checkpoint";
        const cp = createCheckpoint(summary, {
          commitType: "feat",
          push: args.includes("--push"),
        });
        printJSON(cp);
      }
      break;
    }

    case "rollback": {
      if (args[0] === "preview") {
        const preview = rollbackPreview(args[1]);
        printJSON(preview);
      } else if (args[0] === "--files") {
        const files = args.slice(1);
        const result = rollbackFiles(files);
        printJSON(result);
      } else {
        const result = rollbackTo(args[0]);
        printJSON(result);
      }
      break;
    }

    case "health": {
      if (args[0] === "quick") {
        const result = runQuickHealthCheck();
        printJSON(result);
      } else {
        const result = runHealthCheck();
        printJSON(result);
      }
      break;
    }

    case "diagnose": {
      const report = diagnose();
      printJSON(report);
      break;
    }

    case "repair": {
      const result = repair();
      printJSON(result);
      break;
    }

    default:
      console.log(`GitHub Updates Agent 🔔

Usage: npx tsx agents/github-updates/index.ts <command> [args]

Commands:
  checkpoint [summary]       创建原子提交 + checkpoint
  checkpoint list [n]        列出最近 n 个 checkpoints
  checkpoint status          显示工作区状态
  rollback [checkpoint-id]   回滚到指定/上一个 checkpoint
  rollback preview [id]      预览回滚影响
  rollback --files <paths>   选择性文件回滚
  health                     完整健康检查
  health quick               快速健康检查
  diagnose                   诊断当前问题
  repair                     运行自修复流程
`);
  }
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
