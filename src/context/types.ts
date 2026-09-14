/**
 * Context types for the CoHub context sharing engine.
 */

export type ContextStrategy = "relevant" | "summary" | "none";

export interface RelevantFile {
  path: string;
  reason: string;
  lines?: string;
}

export interface TaskContext {
  taskId: string;
  parentSessionId: string;
  agentType: string;
  strategy: ContextStrategy;
  // Extracted from parent session messages
  relevantFiles: RelevantFile[];
  keyDecisions: string[];
  errors: string[];
  summary: string;
  filled: boolean;
  createdAt: number;
}

export interface ContextEngineConfig {
  strategy: ContextStrategy;
  maxFiles: number;
  maxDecisions: number;
}