#!/usr/bin/env node
/**
 * Hook: PreToolUse / PostToolUse — Agent/Task 工具调用追踪
 *
 * 在 Agent/Task 工具调用前后登记/完成任务到 tracker 状态文件，
 * 使 job-board 面板能准确展示子代理的状态，避免僵尸任务。
 *
 * 两个事件共享同一个脚本，通过 hook_event_name 区分分支。
 * 静默执行：不向 stdout 输出任何内容（避免 JSON schema 校验失败），
 * 任何异常均静默吞掉以保证不阻塞工具调用。
 */

import * as fs from "node:fs";

import {
  readTrackerState,
  registerExternalJob,
  completeOldestBySkill,
  failTaskBySkill,
} from "../tracker.js";

const STDIN_TIMEOUT_MS = 3000;

try {
  const payload = readStdinSync();
  if (!payload) process.exit(0);

  const hookEvent = payload.hook_event_name as string | undefined;
  const toolName = payload.tool_name as string | undefined;

  // 仅关心 Agent / Task 工具
  if (!toolName || !/^(Agent|Task)$/.test(toolName)) process.exit(0);

  const toolInput = (payload.tool_input ?? {}) as Record<string, unknown>;
  const skill = (toolInput.subagent_type as string | undefined)
    ?? (toolInput.description as string | undefined)
    ?? "unknown";
  const description = (toolInput.description as string | undefined) ?? "";

  // 从 payload 中尝试提取工具调用唯一标识，按常见字段名顺序回退
  const hookCallId: string | undefined = (
    payload.tool_use_id as string | undefined
    ?? payload.tool_call_id as string | undefined
    ?? payload.call_id as string | undefined
    ?? toolInput.tool_use_id as string | undefined
    ?? toolInput.tool_call_id as string | undefined
    ?? toolInput.call_id as string | undefined
    ?? toolInput.id as string | undefined
  );

  if (hookEvent === "PreToolUse") {
    const state = readTrackerState();
    registerExternalJob(state, {
      skill,
      prompt: description.slice(0, 200),
      hookCallId,
    });
  } else if (hookEvent === "PostToolUse") {
    const state = readTrackerState();
    completeOldestBySkill(state, skill, hookCallId);
  } else if (hookEvent === "PostToolUseFailure") {
    const state = readTrackerState();
    // 从 payload 容错提取错误信息
    const error =
      (payload.error as string | undefined)
      ?? (payload.tool_result as string | undefined)
      ?? (payload.stderr as string | undefined)
      ?? undefined;
    failTaskBySkill(state, skill, { hookCallId, error });
  }

  // 静默退出：不输出任何内容到 stdout
  process.exit(0);
} catch {
  // 任何异常都不得让 hook 失败（exit code 2 会阻断工具调用）
  process.exit(0);
}

// --- Helpers ---

interface StdinPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * 从 stdin 同步读取完整 JSON payload。
 * 通过 fs.readSync 循环读取全部可用字节，带超时保护。
 */
function readStdinSync(): StdinPayload | null {
  const fd = process.stdin.fd;

  // TTY 说明无管道数据
  if (process.stdin.isTTY) return null;

  const start = Date.now();
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);

  try {
    let n: number;
    while (true) {
      if (Date.now() - start > STDIN_TIMEOUT_MS) break;
      n = fs.readSync(fd, buf, 0, 65536, null);
      if (n <= 0) break; // EOF
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
  } catch {
    // readSync 异常（如 EAGAIN）时尝试解析已读内容
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