#!/usr/bin/env node
/**
 * Hook: UserPromptSubmit — 编排模式提醒
 *
 * 在每次用户提交提示时，重申编排模式规则，确保
 * "所有请求必须先走 co-orchestrator" 在长会话/上下文压缩后仍然生效。
 *
 * 输出格式：JSON，含 additionalContext 字段。
 */

const REMINDER = `[CoHub 编排规则] 本请求必须先调用 co-orchestrator 技能进行编排，禁止直接处理；委派时直接用 Agent 工具 spawn 专用角色 agent（如 co-explorer，subagent_type 用角色裸名）；仅在需要注入父会话上下文时才先调 co_delegate；若编排流程已在进行中则继续执行。子代理忽略此规则。`;

process.stdout.write(JSON.stringify({ additionalContext: REMINDER }));
process.exit(0);
