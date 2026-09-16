/**
 * Tests: Grep 计数保险丝 hook
 *
 * 用临时 ZCODE_HOME 隔离状态文件，测完清理。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// 在 import 被测试模块前设置 ZCODE_HOME，让状态文件指向临时目录
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grep-counter-test-"));
process.env.ZCODE_HOME = tmpDir;

// 清理旧环境变量备份
import {
  processGrepEvent,
  cleanupStaleSessions,
  readGrepCounterState,
  writeGrepCounterState,
  handleGrepEvent,
  type GrepCounterState,
} from "./grep-counter.ts";

const WINDOW_MS = 10 * 60 * 1000;
const COOLDOWN_MS = 15 * 60 * 1000;
const STALE_SESSION_MS = 2 * 60 * 60 * 1000;

beforeEach(() => {
  // 清理临时目录下的状态文件
  const stateDir = path.join(tmpDir, "cli", "plugins", "data", "zcode-cohub@local");
  const stateFile = path.join(stateDir, "grep-counter-state.json");
  try { fs.unlinkSync(stateFile); } catch { /* ignore */ }
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

afterEach(() => {
  // 清理临时目录
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// 工具：生成 n 个刚好在窗口内的时间戳（从 now 依次递减 1ms）
function makeTimestamps(now: number, n: number, offsetMs = 0): number[] {
  const ts: number[] = [];
  for (let i = 0; i < n; i++) {
    ts.push(now - offsetMs - i);
  }
  return ts;
}

describe("processGrepEvent — 纯函数测试", () => {
  test("1. 窗口内 29 次 → 不提醒；第 30 次 → warn=true 且 message 含 co_scan", () => {
    const now = Date.now();
    const state: GrepCounterState = {
      sessions: {
        "session-1": { timestamps: makeTimestamps(now, 29) },
      },
      updatedAt: now,
    };

    // 第 30 次触发
    const result = processGrepEvent(state, "session-1", now + 30);
    expect(result.warn).toBe(true);
    expect(result.message).toContain("co_scan");
    // 状态已更新
    expect(result.state.sessions["session-1"].timestamps.length).toBe(30);
    expect(result.state.sessions["session-1"].lastWarnedAt).toBe(now + 30);
  });

  test("2. 冷却期：提醒后 15 分钟内不再提醒；超过冷却期再超阈值会再次提醒", () => {
    const now = Date.now();
    const state: GrepCounterState = {
      sessions: {
        "session-1": {
          timestamps: makeTimestamps(now, 30),
          lastWarnedAt: now, // 刚提醒过
        },
      },
      updatedAt: now,
    };

    // 冷却期内再 Grep，不提醒
    const result1 = processGrepEvent(state, "session-1", now + 10);
    expect(result1.warn).toBe(false);

    // 时间推进到冷却期结束后（16 分钟后），重新凑够 30 次
    const later = now + COOLDOWN_MS + 60_000; // 冷却期后 1 分钟
    const state2: GrepCounterState = {
      sessions: {
        "session-1": {
          timestamps: makeTimestamps(later, 30),
          lastWarnedAt: now,
        },
      },
      updatedAt: now,
    };
    const result2 = processGrepEvent(state2, "session-1", later + 1);
    expect(result2.warn).toBe(true);
    expect(result2.message).toContain("co_scan");
  });

  test("3. 滚动窗口：所有时间戳在窗口外 → 计数为 0，不会提醒", () => {
    const now = Date.now();
    const state: GrepCounterState = {
      sessions: {
        "session-1": {
          timestamps: makeTimestamps(now - WINDOW_MS - 1000, 30), // 全部在窗口外
        },
      },
      updatedAt: now,
    };

    const result = processGrepEvent(state, "session-1", now);
    // 窗口修剪后只剩当前这次
    expect(result.state.sessions["session-1"].timestamps.length).toBe(1);
    expect(result.warn).toBe(false);
  });

  test("4. Session 隔离：两个 session 各自计数互不影响", () => {
    const now = Date.now();
    const state: GrepCounterState = {
      sessions: {
        "session-a": { timestamps: makeTimestamps(now, 30) },
        "session-b": { timestamps: makeTimestamps(now, 5) },
      },
      updatedAt: now,
    };

    // session-a 已有 30 次，触发阈值
    const resultA = processGrepEvent(state, "session-a", now + 1);
    expect(resultA.warn).toBe(true);

    // session-b 仅 5 次，不触发
    const stateB: GrepCounterState = {
      sessions: {
        "session-a": { timestamps: makeTimestamps(now, 30) },
        "session-b": { timestamps: makeTimestamps(now, 5) },
      },
      updatedAt: now,
    };
    const resultB = processGrepEvent(stateB, "session-b", now + 1);
    expect(resultB.warn).toBe(false);
  });
});

describe("handleGrepEvent — 集成逻辑测试（读写文件）", () => {
  test("5. 无 session_id 的 payload → 不计数、无输出", () => {
    const result = handleGrepEvent({ tool_name: "Grep" }, Date.now());
    expect(result.warn).toBe(false);
    expect(result.message).toBeUndefined();

    // 状态文件不应有内容
    const state = readGrepCounterState();
    expect(Object.keys(state.sessions).length).toBe(0);
  });

  test("6. 非法 JSON 非工具事件 → 独立测试 handleGrepEvent 能处理任意 payload", () => {
    // 传入非对象
    const result1 = handleGrepEvent("not an object", Date.now());
    expect(result1.warn).toBe(false);

    // 传入 null
    const result2 = handleGrepEvent(null, Date.now());
    expect(result2.warn).toBe(false);

    // 传入 undefined 性质的模拟
    const result3 = handleGrepEvent(undefined, Date.now());
    expect(result3.warn).toBe(false);
  });

  test("7. 状态文件损坏 → 视为空状态不崩溃", () => {
    // 写一个损坏的文件
    const stateDir = path.join(tmpDir, "cli", "plugins", "data", "zcode-cohub@local");
    const stateFile = path.join(stateDir, "grep-counter-state.json");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, "this is not valid json", "utf-8");

    // 读取不应抛异常
    const state = readGrepCounterState();
    expect(Object.keys(state.sessions).length).toBe(0);
  });

  test("8. 旧 session 清理：2 小时前的条目被剪掉", () => {
    const now = Date.now();
    const state: GrepCounterState = {
      sessions: {
        "active-session": {
          timestamps: [now - 1000], // 最近还有活动
          lastWarnedAt: now - 1000,
        },
        "stale-session": {
          timestamps: [now - STALE_SESSION_MS - 10_000], // 2 小时前
          lastWarnedAt: now - STALE_SESSION_MS - 10_000,
        },
      },
      updatedAt: now,
    };

    const cleaned = cleanupStaleSessions(state, now);
    expect(cleaned.sessions["active-session"]).toBeDefined();
    expect(cleaned.sessions["stale-session"]).toBeUndefined();
    expect(Object.keys(cleaned.sessions).length).toBe(1);
  });
});

describe("集成：完整工作流", () => {
  test("完整流程：连续 Grep 达到阈值触发提醒", () => {
    const now = Date.now();
    const sessionId = "integration-test-session";

    // 模拟 29 次 Grep → 不触发
    for (let i = 0; i < 29; i++) {
      const payload = {
        tool_name: "Grep",
        session_id: sessionId,
      };
      const result = handleGrepEvent(payload, now + i);
      expect(result.warn).toBe(false);
    }

    // 第 30 次 → 触发
    const payload30 = {
      tool_name: "Grep",
      session_id: sessionId,
    };
    const result30 = handleGrepEvent(payload30, now + 30);
    expect(result30.warn).toBe(true);
    expect(result30.message).toContain("co_scan");

    // 冷却期内不触发
    const payload31 = {
      tool_name: "Grep",
      session_id: sessionId,
    };
    const result31 = handleGrepEvent(payload31, now + 31);
    expect(result31.warn).toBe(false);
  });
});