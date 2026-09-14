/**
 * co_close_job MCP Tool — cancels a running background job.
 * Only callable by the co-orchestrator.
 */

import type { TaskTracker } from "../tracker.js";

export interface CloseJobInput {
  task_id: string;
}

export interface CloseJobResult {
  success: boolean;
  task_id: string;
  message: string;
}

/**
 * Tool definition for co_close_job.
 */
export function createCloseJobTool() {
  return {
    name: "co_close_job",
    description:
      "取消指定的后台作业。只能由 co-orchestrator 调用。通过 task_id 或别名查找并中止作业。",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: {
          type: "string",
          description: "要取消的任务 ID 或别名（如 fix-1, exp-2）",
        },
      },
      required: ["task_id"],
    },
  };
}

/**
 * Handle co_close_job tool call.
 */
export async function closeJobHandler(
  input: CloseJobInput,
  services: { tracker: TaskTracker },
): Promise<CloseJobResult> {
  const { task_id } = input;
  const { tracker } = services;

  // Find the job
  const job = tracker.getJob(task_id);
  if (!job) {
    return {
      success: false,
      task_id,
      message: `未找到作业: "${task_id}"。请确认 task_id 或别名正确。`,
    };
  }

  // Can only cancel running/pending jobs
  if (job.status !== "running" && job.status !== "pending") {
    return {
      success: false,
      task_id,
      message: `作业 "${task_id}" 当前状态为 ${job.status}，无法取消。只能取消 running 或 pending 的作业。`,
    };
  }

  // Mark cancelled
  const childSessionId = tracker.abortJob(task_id);

  return {
    success: true,
    task_id,
    message: childSessionId
      ? `作业 "${task_id}" (${job.alias}) 已取消。子会话 ${childSessionId} 已中止。`
      : `作业 "${task_id}" (${job.alias}) 已取消。`,
  };
}