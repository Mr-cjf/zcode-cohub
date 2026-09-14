/**
 * co_delegate MCP Tool — delegates a task to a CoHub skill/agent.
 *
 * This is the core delegation primitive. It:
 * 1. Validates the skill name
 * 2. Loads the skill's role brief from the generated skill briefs
 * 3. Registers the task in TaskTracker
 * 4. Registers context in ContextEngine
 * 5. Returns `subagent_type` + prompts for ZCode subagent execution
 *
 * Since ZCode's MCP tools run inside the agent loop, the actual subagent spawn
 * happens when the caller spawns the specialized subagent named by
 * `subagent_type`, passing `agent_prompt` as the task prompt. The spawned
 * agent's system prompt already carries the role definition, so `agent_prompt`
 * deliberately omits the role brief; `inline_prompt` carries the brief for the
 * fallback path (general-purpose). Both prompt paths append `PARALLEL_DISCIPLINE`
 * (parallel tool-call discipline), so every role — including the general-purpose
 * fallback — is told to batch independent read-only calls in one message.
 */

import type { TaskTracker } from "../tracker.js";
import type { ContextEngine } from "../context/engine.js";
import type { ContextStrategy } from "../context/types.js";
import { SKILL_BRIEFS } from "../skills-briefs.js";

// Role briefs are a single source of truth: src/skills-briefs.ts, auto-generated
// from skills/*/SKILL.md. Never hardcode them here — edit the SKILL.md source
// and rebuild instead.

/** The orchestrator drives the main session; it is never a spawn target. */
const EXCLUDED_SKILLS = ["co-orchestrator"] as const;

const VALID_SKILLS = Object.keys(SKILL_BRIEFS).filter(
  (name) => !EXCLUDED_SKILLS.includes(name as (typeof EXCLUDED_SKILLS)[number]),
);

/**
 * 并行工具纪律（任务提示层统一注入）。
 *
 * 子代理的 system prompt 只定义角色，任务提示层原本没有任何并行调用要求，
 * 这是覆盖所有角色（含 general-purpose 降级路径）的最大断点。此处统一注入，
 * 且刻意不放进 tool description —— 避免每次会话的 token 开销。
 *
 * 同步约束：改动本条纪律须与 skills/*\/SKILL.md 的「## 并行工具纪律」小节保持一致（SKILL.md 为权威源）。
 */
const PARALLEL_DISCIPLINE = [
  `## 并行工具纪律（强制）`,
  `- 互相独立的只读调用（Read/Grep/Glob/WebFetch/WebSearch）必须在同一条消息内一次性并行发起；禁止"等一个结果返回再发下一个"`,
  `- 需要多个文件时：先并行 read 全部文件，再统一分析/修改；有 Bash 时把多个独立 shell 步骤合并为一条 Bash（\`cmd1 && cmd2\`）`,
  `- 仅在存在数据依赖时才串行（Bash/Edit/Write 的串行执行是平台设计，同轮批量提交仍可减少等待）`,
].join("\n");

export interface DelegateInput {
  skill: string;
  prompt: string;
  task_id?: string;
  context_messages?: string;
}

export interface DelegateResult {
  success: boolean;
  task_id: string;
  skill: string;
  /** Bare subagent name to spawn with the Agent tool, e.g. "co-explorer". */
  subagent_type: string;
  /** Task prompt for the specialized subagent (no role brief). */
  agent_prompt: string;
  /** Fully injected prompt including the role brief — fallback (general-purpose). */
  inline_prompt: string;
  context_summary?: string;
  error?: string;
}

/**
 * Tool definition for co_delegate.
 */
export function createDelegateTool() {
  return {
    name: "co_delegate",
    description:
      "将任务委派给指定的 CoHub 专职代理（skill）。校验 skill → 登记任务与上下文 → 返回 subagent_type 与提示词。" +
      "拿到结果后请用 Agent 工具以 subagent_type 直接 spawn 对应的专职 subagent（其 system prompt 已包含角色定义，无需重复注入），" +
      "并把 agent_prompt 作为任务提示传入；若 subagent_type 不可用，则降级为 general-purpose 并把 inline_prompt（含角色 brief 的完整注入版）作为提示。" +
      "本工具本身不执行任务，只负责派发。",
    inputSchema: {
      type: "object" as const,
      properties: {
        skill: {
          type: "string",
          description: `专职代理名。有效值：${VALID_SKILLS.join(", ")}`,
        },
        prompt: {
          type: "string",
          description: "自包含的任务描述，含目标/路径/约束/输出格式。角色身份由工具自动注入。",
        },
        task_id: {
          type: "string",
          description: "可选任务 ID，用于追踪。不提供则自动生成。",
        },
        context_messages: {
          type: "string",
          description: "可选：父会话的消息上下文（JSON 字符串），用于上下文共享。",
        },
      },
      required: ["skill", "prompt"],
    },
  };
}

/**
 * Handle co_delegate tool call.
 */
export async function delegateHandler(
  input: DelegateInput,
  services: {
    tracker: TaskTracker;
    contextEngine: ContextEngine;
    projectDir: string;
    resolveStrategy: (agentType: string) => ContextStrategy;
  },
): Promise<DelegateResult> {
  const { skill, prompt, task_id, context_messages } = input;
  const { tracker, contextEngine, resolveStrategy } = services;

  // Validate skill
  if (!VALID_SKILLS.includes(skill)) {
    return {
      success: false,
      task_id: task_id || "unknown",
      skill,
      subagent_type: "",
      agent_prompt: "",
      inline_prompt: "",
      error: `无效的 skill 名称: "${skill}"。有效值：${VALID_SKILLS.join(", ")}`,
    };
  }

  // Generate task ID
  const generatedId =
    task_id || `cohub-${skill}-${Date.now().toString(36)}`;

  // Register in tracker
  tracker.registerBeforeTask({
    taskId: generatedId,
    skill,
    prompt,
  });

  // Register context
  const strategy = resolveStrategy(skill);
  contextEngine.registerContext({
    taskId: generatedId,
    parentSessionId: "",
    agentType: skill,
    strategy,
  });

  // Fill context if messages provided
  if (context_messages) {
    contextEngine.fillContext(generatedId, context_messages);
  }

  // Build prompts
  const brief = SKILL_BRIEFS[skill].brief;
  const contextBlock = contextEngine.getFormattedContext(generatedId);
  const taskSection = [
    `## 任务`,
    prompt,
    "",
    `---`,
    `任务ID: ${generatedId}`,
  ].join("\n");

  // agent_prompt — task prompt for the specialized subagent: context + task only.
  // The role brief is intentionally omitted (the subagent's system prompt already
  // defines the role; duplicating it wastes tokens and risks conflicting instructions).
  // PARALLEL_DISCIPLINE is appended so the task prompt layer enforces parallel tool calls.
  const agentPrompt = [contextBlock, "", taskSection, "", PARALLEL_DISCIPLINE]
    .filter(Boolean)
    .join("\n");

  // inline_prompt — full injection including the role brief. Fallback for when
  // subagent_type is unavailable (e.g. spawning general-purpose instead).
  const inlinePrompt = [
    `[系统指令] ${brief}`,
    "",
    contextBlock,
    "",
    taskSection,
    "",
    PARALLEL_DISCIPLINE,
  ]
    .filter(Boolean)
    .join("\n");

  // Get context summary
  const ctx = contextEngine.getContext(generatedId);
  const contextSummary = ctx?.filled
    ? `strategy=${strategy}, files=${ctx.relevantFiles.length}, decisions=${ctx.keyDecisions.length}`
    : "no context";

  return {
    success: true,
    task_id: generatedId,
    skill,
    // Skill names are already the bare subagent names (e.g. "co-explorer").
    subagent_type: skill,
    agent_prompt: agentPrompt,
    inline_prompt: inlinePrompt,
    context_summary: contextSummary,
  };
}