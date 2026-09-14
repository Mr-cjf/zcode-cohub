#!/usr/bin/env node
/**
 * Hook: UserPromptSubmit — 注入 Background Job Board
 *
 * 在每次用户提交提示时，读取 tracker 状态文件并生成后台任务面板。
 * 如果有活跃任务，将面板注入到 additionalContext。
 *
 * 输出格式：JSON，含 additionalContext 字段。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Resolve tracker state file path — 与 src/tracker.ts 落盘路径严格一致
// 数据目录: <ZCODE_HOME>/cli/plugins/data/zcode-cohub@local（与 scripts/install.ts 的 DATA_DIR 同源）
const zcodeHome = process.env.ZCODE_HOME
  ? path.resolve(process.env.ZCODE_HOME)
  : path.join(os.homedir(), ".zcode");
const stateDir = path.join(zcodeHome, "cli", "plugins", "data", "zcode-cohub@local");
const trackerFile = path.join(stateDir, "tracker-state.json");

// 非终态任务（pending/running）的过期阈值：30 分钟。
// 与 src/tracker.ts 的 STALE_TASK_MS 保持一致（两个独立部署单元，不强行共享代码）：
// MCP 进程收不到子代理的结束回调，超时任务只能视同已结束；tracker 只在 persist() 时清理，
// 读侧再补一道同样的时间衰减，防止落盘后长时间无新 persist 时面板残留过期条目。
const STALE_TASK_MS = 30 * 60 * 1000;

try {
  if (fs.existsSync(trackerFile)) {
    const raw = fs.readFileSync(trackerFile, "utf-8");
    const state = JSON.parse(raw);

    // Generate board text from state
    const boardText = buildBoardText(state);

    if (boardText) {
      const output = { additionalContext: boardText };
      process.stdout.write(JSON.stringify(output));
    } else {
      // No active jobs — return empty JSON (passes validation)
      process.stdout.write("{}");
    }
  } else {
    process.stdout.write("{}");
  }
} catch {
  // On any error, pass silently
  process.stdout.write("{}");
}
process.exit(0);

// --- Helpers ---

interface JobRecord {
  taskId: string;
  alias: string;
  skill: string;
  status: string;
  startedAt: number;
  completedAt?: number;
}

interface TrackerState {
  jobs: JobRecord[];
  updatedAt: number;
}

function buildBoardText(state: TrackerState): string {
  const now = Date.now();
  const active = (state.jobs || []).filter(
    (j) =>
      (j.status === "pending" || j.status === "running") &&
      // 过期条目视同已结束，不再显示（与 tracker 落盘前清理同一阈值）
      !(now - j.startedAt > STALE_TASK_MS),
  );
  if (active.length === 0) return "";

  const lines = ["", "## 🔄 CoHub 后台任务面板", ""];
  lines.push("| 别名 | 代理 | 状态 | 耗时 |");
  lines.push("|------|------|------|------|");

  for (const job of active) {
    const duration = job.startedAt
      ? `${Math.round((now - job.startedAt) / 1000)}s`
      : "-";
    const statusEmoji: Record<string, string> = {
      pending: "⏳",
      running: "🔄",
      completed: "✅",
      failed: "❌",
      cancelled: "⏹️",
    };
    lines.push(
      `| ${job.alias} | ${job.skill} | ${statusEmoji[job.status] || "❓"} ${job.status} | ${duration} |`,
    );
  }

  return lines.join("\n");
}