#!/usr/bin/env node
/**
 * Hook: PostToolUse — Grep 计数保险丝
 *
 * 监听 Grep 工具调用，按 session 维护滚动窗口计数。
 * 窗口（10 分钟）内 Grep 次数 >= 30 且距上次提醒超过冷却期（15 分钟）时，
 * 向 stdout 输出 additionalContext JSON 提醒模型改用 co_scan，避免穷举式逐项 Grep。
 *
 * 静默执行：不满足条件时 stdout 为空。任何异常静默 exit 0。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

// --- Constants ---

/** 滚动窗口时长：10 分钟 */
const WINDOW_MS = 10 * 60 * 1000;

/** 窗口内 Grep 次数阈值 */
const THRESHOLD = 30;

/** 两次提醒之间的冷却期：15 分钟 */
const COOLDOWN_MS = 15 * 60 * 1000;

/** Session 无活动超时：2 小时，超出则清理 */
const STALE_SESSION_MS = 2 * 60 * 60 * 1000;

/** stdin 读取超时：3 秒 */
const STDIN_TIMEOUT_MS = 3000;

/** 提醒文案 */
const WARN_MESSAGE =
  "[CoHub 提示] 本会话最近 10 分钟内已发起 30+ 次 Grep。若你在做逐符号/逐项的穷举统计（引用计数、找零引用、批量存在性检查），请改用一次 co_scan MCP 调用（symbols 传全部待查符号、root_dir 传项目根目录）替代逐项 Grep——一次调用快 100 倍以上。若确属正常的定点搜索，忽略本提示。";

// --- Types ---

export interface GrepCounterState {
  sessions: Record<string, SessionState>;
  updatedAt: number;
}

interface SessionState {
  timestamps: number[];
  lastWarnedAt?: number;
}

interface StdinPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  session_id?: string;
  [key: string]: unknown;
}

export interface GrepEventResult {
  warn: boolean;
  message?: string;
}

// --- State management ---

/** 状态目录路径（与 tracker.ts 的 getStateDir 一致） */
function getStateDir(): string {
  const zcodeHome = process.env.ZCODE_HOME
    ? path.resolve(process.env.ZCODE_HOME)
    : path.join(os.homedir(), ".zcode");
  return path.join(zcodeHome, "cli", "plugins", "data", "zcode-cohub@local");
}

/** 状态文件路径 */
function getStateFilePath(): string {
  return path.join(getStateDir(), "grep-counter-state.json");
}

/** 原子写：先写临时文件再 rename，避免读端拿到撕裂的 JSON */
function writeFileAtomic(filePath: string, data: string): void {
  const tmpPath = filePath + ".tmp";
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(tmpPath, data, "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

/**
 * 读取 grep-counter 状态文件。
 * 文件不存在或损坏时返回空状态。
 */
export function readGrepCounterState(): GrepCounterState {
  try {
    const filePath = getStateFilePath();
    if (!fs.existsSync(filePath)) {
      return { sessions: {}, updatedAt: Date.now() };
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      sessions: (parsed.sessions as Record<string, SessionState>) ?? {},
      updatedAt: (parsed.updatedAt as number) ?? Date.now(),
    };
  } catch {
    return { sessions: {}, updatedAt: Date.now() };
  }
}

/**
 * 原子写 grep-counter 状态文件。
 * 任何写失败静默忽略。
 */
export function writeGrepCounterState(state: GrepCounterState): void {
  try {
    writeFileAtomic(getStateFilePath(), JSON.stringify(state, null, 2));
  } catch {
    // 静默容忍写失败
  }
}

// --- Pure logic ---

/**
 * 处理一次 Grep 事件：更新滚动窗口、检查阈值与冷却期，返回是否需要提醒。
 *
 * 纯函数：不读写文件系统，不产生副作用。
 *
 * @param state   当前状态（不会被修改，返回新状态副本）
 * @param sessionId  会话 ID
 * @param now        当前时间戳（ms）
 * @returns 提醒决策与更新后的状态
 */
export function processGrepEvent(
  state: GrepCounterState,
  sessionId: string,
  now: number,
): { warn: boolean; message?: string; state: GrepCounterState } {
  // 深拷贝 sessions，避免影响输入状态
  const sessionsCopy: Record<string, SessionState> = {};
  for (const [id, sess] of Object.entries(state.sessions)) {
    sessionsCopy[id] = {
      ...sess,
      timestamps: [...sess.timestamps],
    };
  }

  const newState: GrepCounterState = {
    sessions: sessionsCopy,
    updatedAt: now,
  };

  // 初始化 session
  if (!newState.sessions[sessionId]) {
    newState.sessions[sessionId] = { timestamps: [] };
  }

  const session = newState.sessions[sessionId];

  // 剪掉窗口外旧时间戳
  session.timestamps = session.timestamps.filter((ts) => now - ts <= WINDOW_MS);

  // 追加当前时间戳
  session.timestamps.push(now);

  // 窗口内计数
  const count = session.timestamps.length;

  // 未达阈值 → 不提醒
  if (count < THRESHOLD) {
    return { warn: false, state: newState };
  }

  // 冷却期内 → 不提醒
  if (session.lastWarnedAt != null && now - session.lastWarnedAt < COOLDOWN_MS) {
    return { warn: false, state: newState };
  }

  // 触发提醒
  session.lastWarnedAt = now;
  return { warn: true, message: WARN_MESSAGE, state: newState };
}

/**
 * 清理超过 2 小时无活动的 session 条目。
 * 纯函数：返回新状态，不影响输入。
 */
export function cleanupStaleSessions(
  state: GrepCounterState,
  now: number,
): GrepCounterState {
  const sessions: Record<string, SessionState> = {};
  for (const [id, sess] of Object.entries(state.sessions)) {
    const timestamps = sess.timestamps;
    const latestTs =
      timestamps.length > 0
        ? Math.max(...timestamps)
        : (sess.lastWarnedAt ?? 0);
    if (now - latestTs <= STALE_SESSION_MS) {
      sessions[id] = sess;
    }
  }
  return { sessions, updatedAt: now };
}

// --- 顶层编排 ---

/**
 * 处理一次 Grep 事件 payload 的完整流程：
 * 读取状态 → processGrepEvent → cleanupStaleSessions → 写回状态。
 *
 * @param payload  stdin JSON payload（至少含 session_id）
 * @param now      当前时间戳（ms）
 * @returns 提醒决策
 */
export function handleGrepEvent(
  payload: unknown,
  now: number,
): GrepEventResult {
  // 非对象 payload（null/undefined/string）→ 静默跳过
  if (!payload || typeof payload !== "object") {
    return { warn: false };
  }
  const p = payload as Record<string, unknown>;
  const sessionId = p.session_id as string | undefined;

  // 无 session_id → 静默跳过
  if (!sessionId) {
    return { warn: false };
  }

  // 读取当前状态
  const state = readGrepCounterState();

  // 处理事件
  const result = processGrepEvent(state, sessionId, now);

  // 清理过期 session
  const cleaned = cleanupStaleSessions(result.state, now);

  // 写回
  writeGrepCounterState(cleaned);

  return { warn: result.warn, message: result.message };
}

// --- CLI 入口 ---

function main(): void {
  try {
    const payload = readStdinSync();
    if (!payload) process.exit(0);

    const toolName = payload.tool_name as string | undefined;
    // 安全校验：matcher 已保证是 Grep，但双重检查
    if (toolName !== "Grep") process.exit(0);

    const now = Date.now();
    const result = handleGrepEvent(payload, now);

    if (result.warn && result.message) {
      // 输出 additionalContext JSON（严格 schema，仅一个 key）
      process.stdout.write(JSON.stringify({ additionalContext: result.message }));
    }

    process.exit(0);
  } catch {
    // 任何异常静默退出，不阻断工具调用
    process.exit(0);
  }
}

// 直接运行检测守卫：Bun/Node ESM 均可用
const isMain =
  import.meta.url &&
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  main();
}

// --- stdin 读取（与 agent-tracker.ts 同模式） ---

function readStdinSync(): StdinPayload | null {
  const fd = process.stdin.fd;

  if (process.stdin.isTTY) return null;

  const start = Date.now();
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);

  try {
    let n: number;
    while (true) {
      if (Date.now() - start > STDIN_TIMEOUT_MS) break;
      n = fs.readSync(fd, buf, 0, 65536, null);
      if (n <= 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
  } catch {
    // readSync 异常时尝试解析已读内容
  }

  if (chunks.length === 0) return null;

  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw) as StdinPayload;
  } catch {
    return null;
  }
}