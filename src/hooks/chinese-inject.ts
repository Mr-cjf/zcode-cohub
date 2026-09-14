#!/usr/bin/env node
/**
 * Hook: SessionStart — 注入中文语言要求 + 编排模式规则
 *
 * 在会话启动时，将中文语言要求和编排模式规则注入到 additionalContext 中。
 * ZCode 会将 additionalContext 注入到系统提示词。
 *
 * 输出格式：JSON，含 additionalContext 字段。
 */

const CHINESE_LANGUAGE_INSTRUCTION = `# 中文语言要求

- 始终使用中文进行思考、分析和回复。
- 代码和技术术语可用原文，但自然语言部分（解释、说明、建议、方案等）必须用中文。
- 禁止输出英文自然语言。如果你的思考过程包含英文，请在最终回复时翻译为中文。`;

const ORCHESTRATION_INSTRUCTION = `# 编排模式规则（强制）

- 任何用户请求——无论简单还是复杂——都必须先通过 Skill 工具调用 co-orchestrator 技能，由它编排处理。
- 禁止跳过 co-orchestrator 直接执行任务，包括看似很小的请求：简单问答、单文件修改、一句话的解释等。
- 若 co-orchestrator 技能已加载且正在编排中，继续当前编排流程，不要重复调用。
- 子代理（被 co_delegate 派发的 agent）忽略本规则，不得再次触发 co-orchestrator。`;

const output = {
  additionalContext: `${CHINESE_LANGUAGE_INSTRUCTION}\n\n${ORCHESTRATION_INSTRUCTION}`,
};

process.stdout.write(JSON.stringify(output));
process.exit(0);