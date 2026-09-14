/**
 * Context Engine — shared context between parent and child agent sessions.
 *
 * Since ZCode doesn't expose a session-level message API like OpenCode's SDK,
 * this engine operates in an in-memory pass-through mode:
 * - Orchestrator provides relevant context directly in the prompt
 * - The engine augments with structured context markers
 *
 * This is a simplified version compared to the OpenCode ContextEngine which
 * fetched messages via `client.session.messages()`.
 */

import type { TaskContext, ContextStrategy } from "./types.js";
import {
  extractRelevantFiles,
  extractKeyDecisions,
  extractErrors,
  buildSummary,
} from "./extractor.js";
import { formatContextDetails } from "./formatter.js";

export class ContextEngine {
  private contexts: Map<string, TaskContext> = new Map();

  /**
   * Register a new context placeholder for a task.
   */
  registerContext(params: {
    taskId: string;
    parentSessionId: string;
    agentType: string;
    strategy: ContextStrategy;
  }): TaskContext {
    const ctx: TaskContext = {
      taskId: params.taskId,
      parentSessionId: params.parentSessionId,
      agentType: params.agentType,
      strategy: params.strategy,
      relevantFiles: [],
      keyDecisions: [],
      errors: [],
      summary: "",
      filled: false,
      createdAt: Date.now(),
    };
    this.contexts.set(params.taskId, ctx);
    return ctx;
  }

  /**
   * Fill context from provided messages (JSON string array from orchestrator).
   */
  fillContext(taskId: string, messagesJson: string): void {
    const ctx = this.contexts.get(taskId);
    if (!ctx) return;

    try {
      const messages =
        typeof messagesJson === "string" ? JSON.parse(messagesJson) : messagesJson;

      if (Array.isArray(messages)) {
        ctx.relevantFiles = extractRelevantFiles(messages);
        ctx.keyDecisions = extractKeyDecisions(messages);
        ctx.errors = extractErrors(messages);
        ctx.summary = buildSummary(messages);
      }
    } catch {
      // If parsing fails, leave context unfilled
    }

    ctx.filled = true;
  }

  /**
   * Get formatted context details for injection into a subagent prompt.
   */
  getFormattedContext(taskId: string): string {
    const ctx = this.contexts.get(taskId);
    if (!ctx || !ctx.filled) return "";
    return formatContextDetails(ctx);
  }

  /**
   * Get the context object for a task.
   */
  getContext(taskId: string): TaskContext | undefined {
    return this.contexts.get(taskId);
  }

  /**
   * Clean up context for a completed task.
   */
  removeContext(taskId: string): void {
    this.contexts.delete(taskId);
  }

  /**
   * Clean up stale contexts older than `maxAgeMs`.
   */
  cleanupStale(maxAgeMs = 300_000): void {
    const now = Date.now();
    for (const [id, ctx] of this.contexts) {
      if (now - ctx.createdAt > maxAgeMs) {
        this.contexts.delete(id);
      }
    }
  }

  /**
   * Get the number of active contexts.
   */
  get size(): number {
    return this.contexts.size;
  }
}