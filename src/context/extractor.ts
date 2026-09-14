/**
 * Context extraction utilities.
 * Extracts relevant files, key decisions, and errors from message content.
 */

import type { RelevantFile } from "./types.js";

interface MessageContent {
  type: string;
  text?: string;
}

interface Message {
  role: string;
  content?: string | MessageContent[];
}

/**
 * Extract relevant file paths from message text content.
 */
export function extractRelevantFiles(
  messages: Message[],
  maxFiles = 5,
): RelevantFile[] {
  const files: RelevantFile[] = [];
  const seen = new Set<string>();

  // File path patterns
  const filePatterns = [
    // /path/to/file.ext:line
    /([^\s`"']+\.[a-zA-Z]{1,6}):(\d+)/g,
    // `path/to/file.ext`
    /`([^`]+\.[a-zA-Z]{1,6})`/g,
    // file.ts, src/file.ts etc in text
    /\b([a-zA-Z0-9_\-/.]+\.(ts|tsx|js|jsx|json|md|css|html|py|rs|go|java))(?:\s|$|[,.;:)])/g,
  ];

  for (const msg of messages) {
    const text = extractText(msg);
    if (!text) continue;

    for (const pattern of filePatterns) {
      let match: RegExpExecArray | null;
      // Reset lastIndex for global regexes
      pattern.lastIndex = 0;
      while ((match = pattern.exec(text)) !== null) {
        const filePath = match[1];
        if (seen.has(filePath) || seen.size >= maxFiles) continue;
        seen.add(filePath);
        files.push({
          path: filePath,
          reason: `referenced in ${msg.role} message`,
          lines: match[2] ? `line ${match[2]}` : undefined,
        });
      }
    }
  }

  return files;
}

/**
 * Extract key decisions from message content.
 */
export function extractKeyDecisions(messages: Message[], maxDecisions = 3): string[] {
  const decisions: string[] = [];
  const decisionKeywords = [
    "决定", "决策", "选定", "采用", "使用", "选择了",
    "decide", "decision", "choose", "chose", "settle",
  ];

  for (const msg of messages) {
    const text = extractText(msg);
    if (!text) continue;

    for (const keyword of decisionKeywords) {
      const idx = text.indexOf(keyword);
      if (idx !== -1 && decisions.length < maxDecisions) {
        const snippet = text.slice(Math.max(0, idx - 20), idx + 100).trim();
        decisions.push(snippet);
      }
    }
  }

  return decisions.slice(0, maxDecisions);
}

/**
 * Extract error information from message content.
 */
export function extractErrors(messages: Message[], maxErrors = 2): string[] {
  const errors: string[] = [];

  for (const msg of messages) {
    const text = extractText(msg);
    if (!text) continue;

    // Extract error-like blocks
    const errorBlocks = text.match(/```error\n?([\s\S]*?)```/g);
    if (errorBlocks) {
      for (const block of errorBlocks) {
        if (errors.length < maxErrors) {
          errors.push(block.replace(/```error\n?/, "").replace(/```$/, "").trim());
        }
      }
    }

    // Extract inline error messages
    const errorPatterns = [/(?:error|Error|ERROR|错误)[：:]\s*(.+?)(?:[\n\r]|$)/g, /(?:failed|失败)[：:]\s*(.+?)(?:[\n\r]|$)/g];

    for (const pattern of errorPatterns) {
      let match: RegExpExecArray | null;
      pattern.lastIndex = 0;
      while ((match = pattern.exec(text)) !== null) {
        if (errors.length < maxErrors) {
          const errMsg = match[1].trim();
          if (!errors.includes(errMsg)) errors.push(errMsg);
        }
      }
    }
  }

  return errors.slice(0, maxErrors);
}

/**
 * Build a brief summary from messages.
 */
export function buildSummary(messages: Message[]): string {
  const texts = messages
    .map(extractText)
    .filter(Boolean)
    .join("\n");

  // Take first ~200 chars (simple heuristic)
  if (texts.length > 200) {
    return texts.slice(0, 200) + "...";
  }
  return texts || "(empty)";
}

/**
 * Extract text content from a message.
 */
function extractText(msg: Message): string {
  if (!msg.content) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");
  }
  return "";
}

/**
 * Enforce prompt budget: truncate to max tokens (approximate).
 * 1 token ≈ 4 characters for Chinese, 0.75 words for English.
 */
export function enforcePromptBudget(text: string, maxTokens = 12000): string {
  // Simple character-based budget: ~4 chars per token for mixed text
  const maxChars = maxTokens * 3;
  if (text.length <= maxChars) return text;

  // Truncate and append notice
  const truncated = text.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf("\n");
  const cutPoint = lastNewline > maxChars * 0.8 ? lastNewline : maxChars;
  return truncated.slice(0, cutPoint) + "\n\n(内容过长已截断...context budget enforced)";
}