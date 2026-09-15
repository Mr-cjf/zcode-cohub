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

/** 状态目录路径 */
function getStateDir(): string {
  const zcodeHome = process.env.ZCODE_HOME
    ? path.resolve(process.env.ZCODE_HOME)
    : path.join(os.homedir(), ".zcode");
  return path.join(zcodeHome, "cli", "plugins", "data", "zcode-cohub@local");
}

/** 状态文件路径 */
function getTrackerFilePath(): string {
  return path.join(getStateDir(), "tracker-state.json");
}

/** 原子写：先写临时文件再 rename，避免读端拿到撕裂的 JSON */
function writeFileAtomic(filePath: string, data: string): void {
  const tmpPath = filePath + ".tmp";
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(tmpPath, data, "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // rename 失败时尽力清理临时文件
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  } finally {
    // 确保成功路径下 .tmp 已被 rename 消耗、失败路径下也已尽力删除
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

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
  /** 工具调用唯一标识，用于精确匹配 PreToolUse/PostToolUse 配对（平台提供时有效） */
  hookCallId?: string;
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
    this.load();
  }

  /**
   * 从持久化文件恢复内存状态。
   * 向后兼容旧格式（无 aliasCounters 字段）。
   */
  private load(): void {
    const filePath = getTrackerFilePath();
    try {
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, "utf-8");
      const state = JSON.parse(raw);
      // 恢复 jobs
      if (Array.isArray(state.jobs)) {
        for (const job of state.jobs) {
          this.jobs.set(job.taskId, job);
        }
      }
      // 恢复 aliasCounters（旧文件无此字段时从已有 job 推导）
      if (state.aliasCounters && typeof state.aliasCounters === "object") {
        for (const [key, value] of Object.entries(state.aliasCounters)) {
          this.aliasCounter.set(key, value as number);
        }
      } else {
        // 旧格式：从已有 jobs 的 alias 字段推导
        const derived = deriveAliasCountersFromJobs([...this.jobs.values()]);
        for (const [key, value] of derived) {
          this.aliasCounter.set(key, value);
        }
      }
    } catch {
      // 文件损坏等静默忽略，保持空初始状态
    }
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
      const aliasCounters: Record<string, number> = {};
      for (const [key, value] of this.aliasCounter) {
        aliasCounters[key] = value;
      }
      const state = {
        jobs: [...this.jobs.values()],
        aliasCounters,
        updatedAt: Date.now(),
      };
      writeFileAtomic(getTrackerFilePath(), JSON.stringify(state, null, 2));
    } catch {
      // ignore — 面板是辅助功能，磁盘问题不得影响主流程
    }
  }

  private nextAlias(skill: string): string {
    const short = skill.replace("co-", "");
    const count = (this.aliasCounter.get(short) || 0) + 1;
    this.aliasCounter.set(short, count);
    return `${short}-${count}`;
  }
}

/**
 * 从已有 job 记录推导每个 skill 短名的最大别名计数。
 * 别名格式形如 `<skill短名>-<数字>`（如 `explorer-1`、`rule-user-3`），
 * skill 短名可能含连字符（如 `rule-user`），因此从最后一个连字符处切分数字后缀。
 * 无法匹配 alias 格式的记录跳过。
 */
function deriveAliasCountersFromJobs(jobs: JobRecord[]): Map<string, number> {
  const counters = new Map<string, number>();
  for (const job of jobs) {
    const alias = job.alias;
    if (!alias) continue;
    const lastHyphenIdx = alias.lastIndexOf("-");
    if (lastHyphenIdx === -1 || lastHyphenIdx === alias.length - 1) continue;
    const numStr = alias.slice(lastHyphenIdx + 1);
    const num = parseInt(numStr, 10);
    if (isNaN(num)) continue;
    const short = alias.slice(0, lastHyphenIdx);
    const current = counters.get(short) ?? 0;
    if (num > current) counters.set(short, num);
  }
  return counters;
}

/**
 * 找到指定 skill 中 status 为 running 的任务，标记为 failed，写盘并返回。
 * 配对策略与 completeOldestBySkill 一致：先 hookCallId 精确匹配，再 FIFO 回退。
 * 找不到返回 null。
 */
export function failTaskBySkill(
  state: TrackerState,
  skill: string,
  opts?: { hookCallId?: string; error?: string },
): JobRecord | null {
  const hookCallId = opts?.hookCallId;
  // 优先：按 hookCallId 精确匹配
  if (hookCallId) {
    const exact = state.jobs.find(
      (j) => j.status === "running" && j.skill === skill && j.hookCallId === hookCallId,
    );
    if (exact) {
      exact.status = "failed";
      exact.completedAt = Date.now();
      if (opts?.error) exact.error = opts.error.slice(0, 200);
      state.updatedAt = Date.now();
      writeTrackerState(state);
      return exact;
    }
  }

  // 回退：按最早 startedAt 配对（FIFO）
  let oldest: JobRecord | null = null;
  for (const job of state.jobs) {
    if (job.status === "running" && job.skill === skill) {
      if (!oldest || job.startedAt < oldest.startedAt) {
        oldest = job;
      }
    }
  }
  if (!oldest) return null;

  oldest.status = "failed";
  oldest.completedAt = Date.now();
  if (opts?.error) oldest.error = opts.error.slice(0, 200);
  state.updatedAt = Date.now();
  writeTrackerState(state);
  return oldest;
}

// ============================================================
// 纯函数 API（供 hook 脚本等独立进程复用，不依赖 TaskTracker 实例）
// 路径与状态格式与 TaskTracker 内部实现严格一致。
// ============================================================

/** 完整状态文件结构（含持久化的 aliasCounters） */
export interface TrackerState {
  jobs: JobRecord[];
  aliasCounters?: Record<string, number>;
  updatedAt: number;
}

/**
 * 读取 tracker 状态文件。
 * 文件不存在或损坏时返回空状态。
 * 向后兼容：aliasCounters 缺失时从已有 job 的 alias 字段推导计数起点。
 */
export function readTrackerState(): TrackerState {
  try {
    const filePath = getTrackerFilePath();
    if (!fs.existsSync(filePath)) {
      return { jobs: [], updatedAt: Date.now() };
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    let aliasCounters: Record<string, number> | undefined = parsed.aliasCounters ?? undefined;
    // 旧文件无 aliasCounters 时从 jobs 推导
    if (!aliasCounters) {
      const derived = deriveAliasCountersFromJobs(jobs);
      aliasCounters = {};
      for (const [key, value] of derived) {
        aliasCounters[key] = value;
      }
    }
    return {
      jobs,
      aliasCounters,
      updatedAt: parsed.updatedAt ?? Date.now(),
    };
  } catch {
    return { jobs: [], updatedAt: Date.now() };
  }
}

/**
 * 原子写 tracker 状态文件。
 */
export function writeTrackerState(state: TrackerState): void {
  writeFileAtomic(getTrackerFilePath(), JSON.stringify(state, null, 2));
}

/**
 * 创建一个 status: "running" 的任务记录，生成持久化别名，追加到 state.jobs，写盘并返回。
 * 若提供了 hookCallId，存入任务记录供精确配对使用。
 */
export function registerExternalJob(
  state: TrackerState,
  opts: { skill: string; prompt: string; hookCallId?: string },
): JobRecord {
  const counters = state.aliasCounters ?? {};
  const short = opts.skill.replace("co-", "");
  const count = (counters[short] || 0) + 1;
  counters[short] = count;

  const job: JobRecord = {
    taskId: `hook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    alias: `${short}-${count}`,
    skill: opts.skill,
    prompt: opts.prompt.slice(0, 200),
    status: "running",
    startedAt: Date.now(),
    hookCallId: opts.hookCallId,
  };

  state.jobs.push(job);
  state.aliasCounters = counters;
  state.updatedAt = Date.now();
  writeTrackerState(state);
  return job;
}

/**
 * 找到指定 skill 中 status 为 running 的任务，标记为 completed，写盘并返回。
 *
 * 配对优先级：
 * 1. 提供了 hookCallId 且能在 running 任务中精确匹配 → 完成那一条。
 * 2. 回退：按 startedAt 最早（FIFO）配对。
 *
 * 回退场景的已知局限：当同一 skill 的多个任务并发且完成顺序乱序时，
 * 耗时数字可能与真实任务不对应，但状态数量始终正确（不会产生僵尸任务）。
 */
export function completeOldestBySkill(
  state: TrackerState,
  skill: string,
  hookCallId?: string,
): JobRecord | null {
  // 优先：按 hookCallId 精确匹配
  if (hookCallId) {
    const exact = state.jobs.find(
      (j) => j.status === "running" && j.skill === skill && j.hookCallId === hookCallId,
    );
    if (exact) {
      exact.status = "completed";
      exact.completedAt = Date.now();
      state.updatedAt = Date.now();
      writeTrackerState(state);
      return exact;
    }
  }

  // 回退：按最早 startedAt 配对（FIFO）
  let oldest: JobRecord | null = null;
  for (const job of state.jobs) {
    if (job.status === "running" && job.skill === skill) {
      if (!oldest || job.startedAt < oldest.startedAt) {
        oldest = job;
      }
    }
  }
  if (!oldest) return null;

  oldest.status = "completed";
  oldest.completedAt = Date.now();
  state.updatedAt = Date.now();
  writeTrackerState(state);
  return oldest;
}