/**
 * Context strategy resolution.
 * Maps agent types to context sharing strategies.
 */

import type { ContextStrategy } from "./types.js";

const STRATEGY_MAP: Record<string, ContextStrategy> = {
  "co-fixer": "relevant",
  "co-designer": "relevant",
  "co-planner": "relevant",
  "co-oracle": "summary",
  "co-council": "summary",
  "co-explorer": "none",
  "co-librarian": "none",
  "co-observer": "none",
  "co-rule-user": "none",
  "co-rule-project": "none",
  "co-rule-app": "none",
};

/**
 * Resolve the context strategy for an agent type.
 * Falls back to "none" if the agent type is unknown.
 */
export function resolveStrategy(agentType: string): ContextStrategy {
  return STRATEGY_MAP[agentType] ?? "none";
}

/**
 * Check if a strategy requires context (not "none").
 */
export function needsContext(strategy: ContextStrategy): boolean {
  return strategy !== "none";
}