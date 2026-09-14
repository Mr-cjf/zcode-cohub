/**
 * Context formatting utilities.
 * Formats extracted context into markdown blocks for injection into subagent prompts.
 */

import type { TaskContext } from "./types.js";

/**
 * Format a full context block for injection into a subagent prompt.
 */
export function formatContextDetails(ctx: TaskContext): string {
  if (!ctx.filled) return "";
  if (ctx.strategy === "none") return "";

  const parts: string[] = ["[CONTEXT_BLOCK_START]"];

  if (ctx.strategy === "relevant" && ctx.relevantFiles.length > 0) {
    parts.push("## 相关文件");
    for (const file of ctx.relevantFiles) {
      const lineRef = file.lines ? `:${file.lines}` : "";
      parts.push(`- \`${file.path}${lineRef}\` — ${file.reason}`);
    }
    parts.push("");
  }

  if (ctx.keyDecisions.length > 0) {
    parts.push("## 关键决策");
    for (const d of ctx.keyDecisions) {
      parts.push(`- ${d}`);
    }
    parts.push("");
  }

  if (ctx.errors.length > 0) {
    parts.push("## 已知问题");
    for (const e of ctx.errors) {
      parts.push(`- ${e}`);
    }
    parts.push("");
  }

  if (ctx.strategy === "summary" && ctx.summary) {
    parts.push("## 会话摘要");
    parts.push(ctx.summary);
    parts.push("");
  }

  parts.push("[CONTEXT_BLOCK_END]");
  return parts.join("\n");
}

/**
 * Format a context marker for replacement in prompts.
 */
export function formatContextMarker(): string {
  return "[CONTEXT_BLOCK_START]\n(上下文将在任务启动时填充...)\n[CONTEXT_BLOCK_END]";
}

/**
 * Get a brief one-line summary.
 */
export function formatBriefSummary(ctx: TaskContext): string {
  if (!ctx.filled) return "";
  const filesSummary =
    ctx.relevantFiles.length > 0
      ? `${ctx.relevantFiles.length} files`
      : "no files";
  const decisionsSummary =
    ctx.keyDecisions.length > 0
      ? `${ctx.keyDecisions.length} decisions`
      : "";
  const errorsSummary = ctx.errors.length > 0 ? `${ctx.errors.length} errors` : "";
  const parts = [filesSummary, decisionsSummary, errorsSummary].filter(Boolean);
  return `Context: ${parts.join(", ")}`;
}