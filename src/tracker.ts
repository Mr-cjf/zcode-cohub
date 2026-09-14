/**
 * TaskTracker — in-memory job tracking with stats persistence.
 *
 * Tracks all delegate/council subtasks: status, timing, aliases.
 * Generates "Background Job Board" text for hook injection.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// --- Storage ---

/** 状态文件路径 — 与 src/hooks/job-board.ts 读取路径严格一致 */
const zcodeHome = process.env.ZCODE_HOME
  ? path.resolve(process.env.ZCODE_HOME)
  : path.join(os.homedir(), ".zcode");
const stateDir = path.join(zcodeHome, "cli", "plugins", "data", "zcode-cohub@local");
const trackerFile = path.join(stateDir, "tracker-state.json");

/**
 * 非终态任务（pending/running）的过期阈值：30 分钟。
 * MCP 侧无法观察子代理的生命周期 —— 子代理由 Agent 工具 spawn/结束，本进程收不到任何回调，
 * 因此 co_delegate 登记的任务永远不会被更新为终态；超时即视为已结束，落盘前按 failed 归档，
 * 避免 job-board 面板永久残留一条耗时无限增长的 running 条目。
 */
const STALE_TASK_MS = 30 * 60 * 1000;

// --- Types ---

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface JobRecord {
  taskId: string;
  alias: string;
  skill: string;
  prompt: string;
  status: TaskStatus;
  childSessionId?: string;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
}

export interface TaskStats {
  total: number;
  completed: number;
  failed: number;
  active: number;
  avgDurationMs: number;
}

// --- Tracker ---

export class TaskTracker {
  private jobs: Map<string, JobRecord> = new Map();
  private aliasCounter: Map<string, number> = new Map();
  private pluginRoot: string;

  constructor(pluginRoot: string) {
    this.pluginRoot = pluginRoot;
  }

  /**
   * Register a task before execution.
   */
  registerBeforeTask(params: {
    taskId: string;
    skill: string;
    prompt: string;
  }): JobRecord {
    const alias = this.nextAlias(params.skill);

    const job: JobRecord = {
      taskId: params.taskId,
      alias,
      skill: params.skill,
      prompt: params.prompt,
      status: "running",
      startedAt: Date.now(),
    };

    this.jobs.set(params.taskId, job);
    this.persist();
    return job;
  }

  /**
   * Update task after completion.
   */
  updateAfterTask(params: {
    taskId: string;
    status: TaskStatus;
    childSessionId?: string;
    result?: string;
    error?: string;
  }): void {
    const job = this.jobs.get(params.taskId);
    if (!job) return;

    job.status = params.status;
    job.completedAt = Date.now();
    if (params.childSessionId) job.childSessionId = params.childSessionId;
    if (params.result) job.result = params.result;
    if (params.error) job.error = params.error;
    this.persist();
  }

  /**
   * Update task by child session ID.
   */
  updateByChildSessionId(childSessionId: string, updates: Partial<JobRecord>): void {
    for (const job of this.jobs.values()) {
      if (job.childSessionId === childSessionId) {
        Object.assign(job, updates);
        this.persist(); // 仅在命中任务时落盘
        break;
      }
    }
  }

  /**
   * Mark a task as cancelled.
   */
  markCancelled(taskId: string): void {
    const job = this.jobs.get(taskId);
    if (job) {
      job.status = "cancelled";
      job.completedAt = Date.now();
      this.persist();
    }
  }

  /**
   * Get a job by taskId or alias.
   */
  getJob(taskIdOrAlias: string): JobRecord | undefined {
    // Direct lookup
    const job = this.jobs.get(taskIdOrAlias);
    if (job) return job;

    // Alias lookup
    for (const j of this.jobs.values()) {
      if (j.alias === taskIdOrAlias) return j;
    }

    return undefined;
  }

  /**
   * Generate Background Job Board text for injection.
   */
  getBoardText(): string {
    const allJobs = [...this.jobs.values()];
    const active = allJobs.filter(
      (j) => j.status === "pending" || j.status === "running",
    );
    if (active.length === 0) return "";

    const lines = ["", "## 🔄 CoHub 后台任务面板", ""];
    lines.push("| 别名 | 代理 | 状态 | 耗时 |");
    lines.push("|------|------|------|------|");

    for (const job of active) {
      const duration = job.startedAt
        ? `${Math.round((Date.now() - job.startedAt) / 1000)}s`
        : "-";
      const statusEmoji = {
        pending: "⏳",
        running: "🔄",
        completed: "✅",
        failed: "❌",
        cancelled: "⏹️",
      }[job.status];

      lines.push(
        `| ${job.alias} | ${job.skill} | ${statusEmoji} ${job.status} | ${duration} |`,
      );
    }

    // Recent completions
    const recent = allJobs.filter((j) => j.status === "completed");
    if (recent.length > 0) {
      lines.push("");
      lines.push("### 最近完成");
    }

    return lines.join("\n");
  }

  /**
   * Clean up stale running jobs (force-mark as errored after timeout).
   * Returns sessionIds to abort.
   */
  cleanupStaleJobs(timeoutMs = 600_000): string[] {
    const stale = this.sweepStaleJobs(timeoutMs);
    if (stale.length > 0) this.persist();
    return stale
      .map((job) => job.childSessionId)
      .filter((id): id is string => typeof id === "string");
  }

  /**
   * Remove old terminal jobs.
   */
  pruneTerminalJobs(maxAgeMs = 600_000): void {
    const now = Date.now();
    let changed = false;
    for (const [id, job] of this.jobs) {
      if (
        (job.status === "completed" || job.status === "failed" || job.status === "cancelled") &&
        job.completedAt != null &&
        now - job.completedAt > maxAgeMs
      ) {
        this.jobs.delete(id);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /**
   * Compute aggregate statistics.
   */
  computeStats(): TaskStats {
    const allJobs = [...this.jobs.values()];
    const completed = allJobs.filter((j) => j.status === "completed");
    const failed = allJobs.filter((j) => j.status === "failed");
    const active = allJobs.filter(
      (j) => j.status === "running" || j.status === "pending",
    );

    const durations = completed
      .filter((j) => j.completedAt != null)
      .map((j) => j.completedAt! - j.startedAt);

    const avgDurationMs =
      durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0;

    return {
      total: allJobs.length,
      completed: completed.length,
      failed: failed.length,
      active: active.length,
      avgDurationMs,
    };
  }

  /**
   * Get count of active jobs.
   */
  get activeCount(): number {
    return [...this.jobs.values()].filter(
      (j) => j.status === "running" || j.status === "pending",
    ).length;
  }

  /**
   * Find a job by alias and return child session ID for aborting.
   */
  abortJob(taskIdOrAlias: string): string | undefined {
    const job = this.getJob(taskIdOrAlias);
    if (!job) return undefined;
    job.status = "cancelled";
    job.completedAt = Date.now();
    this.persist();
    return job.childSessionId;
  }

  // --- Private ---

  /**
   * 把所有超时的非终态任务标记为 failed（保留原 startedAt，仅追加 error/completedAt）。
   * 纯内存变更、不落盘 —— 供 persist() 与 cleanupStaleJobs() 共用，避免重复实现。
   * @returns 本次被标记为 failed 的任务（空数组表示无变更）
   */
  private sweepStaleJobs(timeoutMs: number): JobRecord[] {
    const now = Date.now();
    const swept: JobRecord[] = [];

    for (const job of this.jobs.values()) {
      if (job.status !== "running" && job.status !== "pending") continue;
      if (!(now - job.startedAt > timeoutMs)) continue;

      job.status = "failed";
      job.error = "timeout";
      job.completedAt = now;
      swept.push(job);
    }

    return swept;
  }

  /**
   * 把 tracker 状态落盘到 stateDir/tracker-state.json（供 job-board hook 读取）。
   * 落盘前先做过期清理：MCP 收不到子代理的完成回调，超过 STALE_TASK_MS 的 pending/running
   * 视为已结束，避免面板永久残留 running 条目（条目随委派次数单调累积）。
   * 静默容忍任何失败：面板是辅助功能，磁盘问题不得影响主流程。
   */
  private persist(): void {
    try {
      this.sweepStaleJobs(STALE_TASK_MS);
      const state = { jobs: [...this.jobs.values()], updatedAt: Date.now() };
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(trackerFile, JSON.stringify(state, null, 2), "utf-8");
    } catch {
      // ignore
    }
  }

  private nextAlias(skill: string): string {
    const short = skill.replace("co-", "");
    const count = (this.aliasCounter.get(short) || 0) + 1;
    this.aliasCounter.set(short, count);
    return `${short}-${count}`;
  }
}