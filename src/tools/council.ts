/**
 * co_council MCP Tool — multi-LLM consensus engine.
 *
 * Runs councillor LLMs (configurable via preset) and detects consensus.
 * This is a simplified port from OpenCode's council.ts.
 *
 * In ZCode, since we can't spawn sessions directly from MCP tools,
 * the council tool runs a structured multi-turn analysis where:
 * 1. The tool returns councillor assignments for ZCode to execute
 * 2. ZCode collects results and calls back for synthesis
 */

import type { TaskTracker } from "../tracker.js";

// --- Types ---

export interface CouncillorConfig {
  name: string;
  model?: string;
  provider?: string;
  variant?: string;
  temperature?: number;
}

export interface CouncilPreset {
  name: string;
  councillors: CouncillorConfig[];
  rounds?: number;
  parallel?: boolean;
}

export interface CouncilInput {
  prompt: string;
  preset?: string;
  councillor_outputs?: string; // JSON string of { [name]: response } for synthesis
}

export interface CouncilResult {
  success: boolean;
  phase: "assign" | "synthesize";
  councillors?: CouncillorConfig[];
  consensus?: {
    verdict: "一致" | "多数" | "分歧";
    conclusion: string;
    details: Record<string, string>;
  };
  error?: string;
}

// --- Presets ---

const PRESETS: Record<string, CouncilPreset> = {
  default: {
    name: "default",
    councillors: [
      { name: "Alpha" },
      { name: "Beta" },
      { name: "Gamma" },
    ],
    rounds: 1,
    parallel: true,
  },
  deep: {
    name: "deep",
    councillors: [
      { name: "Alpha" },
      { name: "Beta" },
      { name: "Gamma" },
      { name: "Delta" },
      { name: "Epsilon" },
    ],
    rounds: 1,
    parallel: true,
  },
  serial: {
    name: "serial",
    councillors: [
      { name: "Round1-Alpha" },
      { name: "Round2-Beta" },
      { name: "Round3-Gamma" },
    ],
    rounds: 3,
    parallel: false,
  },
};

// --- Tool Definition ---

export function createCouncilTool() {
  return {
    name: "co_council",
    description:
      "多模型并行共识工具。Phase 1 (assign): 返回 councillor 分配方案，由 ZCode 并发执行。Phase 2 (synthesize): 接收 councillor 输出，综合共识结论。",
    inputSchema: {
      type: "object" as const,
      properties: {
        prompt: {
          type: "string",
          description: "需要多模型共识的问题或决策描述",
        },
        preset: {
          type: "string",
          enum: ["default", "deep", "serial"],
          description: "预设方案。default: 3 councillors 并行，deep: 5 councillors，serial: 3 轮串行",
        },
        councillor_outputs: {
          type: "string",
          description:
            "Phase 2 合成用：JSON 字符串，格式 { \"councillor_name\": \"response text\", ... }。Phase 1 时省略。",
        },
      },
      required: ["prompt"],
    },
  };
}

// --- Handler ---

export async function councilHandler(
  input: CouncilInput,
  services: {
    tracker: TaskTracker;
    projectDir: string;
  },
): Promise<CouncilResult> {
  const { prompt, preset, councillor_outputs } = input;
  const selectedPreset = preset && PRESETS[preset] ? preset : "default";
  const config = PRESETS[selectedPreset];

  // Phase 1: Assign — return councillor configs for ZCode to execute
  if (!councillor_outputs) {
    return {
      success: true,
      phase: "assign",
      councillors: config.councillors,
    };
  }

  // Phase 2: Synthesize — analyse councillor outputs and detect consensus
  return synthesize(prompt, councillor_outputs, config);
}

// --- Synthesis ---

function synthesize(
  prompt: string,
  outputsJson: string,
  config: CouncilPreset,
): CouncilResult {
  let outputs: Record<string, string>;

  try {
    outputs = JSON.parse(outputsJson);
  } catch {
    return {
      success: false,
      phase: "synthesize",
      error: "无法解析 councillor_outputs，期望 JSON 格式: { \"name\": \"response\" }",
    };
  }

  const entries = Object.entries(outputs);
  if (entries.length < 2) {
    return {
      success: false,
      phase: "synthesize",
      error: "至少需要 2 个 councillor 输出才能进行共识分析",
    };
  }

  // Simple consensus detection:
  // 1. Extract key conclusions (last paragraph from each councillor)
  // 2. Compute Jaccard similarity between each pair
  // 3. If all pairs > threshold → 一致, if majority → 多数, else → 分歧

  const conclusions: { name: string; text: string; tokens: Set<string> }[] = [];

  for (const [name, response] of entries) {
    // Extract last meaningful paragraph as conclusion
    const paragraphs = response.split(/\n\n+/).filter(Boolean);
    const conclusion =
      paragraphs.length > 0 ? paragraphs[paragraphs.length - 1] : response;

    // Tokenize (simple: split by whitespace + punctuation for CJK+EN)
    const tokens = new Set(
      conclusion
        .toLowerCase()
        .split(/[\s，。、；：""''（）．,!\.;:\(\)]+/)
        .filter((t) => t.length > 0),
    );

    conclusions.push({ name, text: conclusion, tokens });
  }

  // Pairwise Jaccard
  let totalSimilarity = 0;
  let pairCount = 0;
  const pairSims: number[] = [];

  for (let i = 0; i < conclusions.length; i++) {
    for (let j = i + 1; j < conclusions.length; j++) {
      const a = conclusions[i].tokens;
      const b = conclusions[j].tokens;
      const intersection = new Set([...a].filter((x) => b.has(x)));
      const union = new Set([...a, ...b]);
      const similarity = intersection.size / (union.size || 1);
      totalSimilarity += similarity;
      pairSims.push(similarity);
      pairCount++;
    }
  }

  const avgSimilarity = pairCount > 0 ? totalSimilarity / pairCount : 0;

  let verdict: "一致" | "多数" | "分歧";
  if (avgSimilarity >= 0.5) {
    verdict = "一致";
  } else if (avgSimilarity >= 0.25) {
    verdict = "多数";
  } else {
    verdict = "分歧";
  }

  // Build conclusion — pick the most central conclusion (highest avg similarity to others)
  let bestConclusion = "";
  let bestScore = -1;

  for (let i = 0; i < conclusions.length; i++) {
    let score = 0;
    for (let j = 0; j < conclusions.length; j++) {
      if (i === j) continue;
      const a = conclusions[i].tokens;
      const b = conclusions[j].tokens;
      const intersection = new Set([...a].filter((x) => b.has(x)));
      const union = new Set([...a, ...b]);
      score += intersection.size / (union.size || 1);
    }
    if (score > bestScore) {
      bestScore = score;
      bestConclusion = conclusions[i].text;
    }
  }

  return {
    success: true,
    phase: "synthesize",
    consensus: {
      verdict,
      conclusion: bestConclusion,
      details: Object.fromEntries(
        conclusions.map((c) => [c.name, c.text]),
      ),
    },
  };
}