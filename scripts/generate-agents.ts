// Generate subagent templates from SKILL.md files.
// Reads each skills/<dir>/SKILL.md, skips the orchestrator (it drives the main
// session instead of being spawned), and writes one agents-template/<name>.md
// per remaining role. Each template pins `model: inherit`, a per-role tool
// whitelist and `maxTurns: 12`; the body is copied verbatim from SKILL.md so the
// skill stays the single source of truth.
//
// `maxTurns` overrides the ZCode subagent default of 4, which is too few for
// roles that read in parallel, batch-edit, verify and report. It is a user key
// like `model`: the installer merges templates by filling a key only when the
// installed agent lacks it, so a value the user changed in Settings → Subagents
// is preserved across re-installs.
//
// Usage:
//   bun scripts/generate-agents.ts           # write agents-template/*.md
//   bun scripts/generate-agents.ts --check   # diff against disk, exit 1 on drift
//
// IMPORTANT: the output directory is `agents-template`, never `agents`.
// A plugin-root `agents/` directory is registered by ZCode as plugin-scope
// agents, which outrank user-scope agents — that would override the model the
// user picks in Settings → Subagents and defeat the purpose of these templates.
// agents-template/ is a template source only: it is deliberately absent from
// package.json "files" and from the installer component list, so it never ships
// inside the plugin bundle. The installer reads it and writes it to the user
// agent directory instead.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SKILLS_DIR = path.join(PROJECT_ROOT, "skills");
const OUTPUT_DIR = path.join(PROJECT_ROOT, "agents-template");

// Roles that stay skills only: the orchestrator is the main-session dispatcher,
// it is never spawned as a subagent.
const EXCLUDED_DIRS = new Set(["orchestrator"]);
const EXCLUDED_NAMES = new Set(["co-orchestrator"]);

// Fixed value so users can switch the model per role in ZCode settings.
const MODEL = "inherit";

// 覆盖 ZCode subagent 默认 maxTurns=4——留给角色「并行读 → 批量改 → 验证 → 报告」的轮次余量。
const MAX_TURNS = 12;

// Per-role tool whitelist (least privilege). Roles that need MCP tool access
// (co-explorer, co-oracle, co-council) use disallowedTools instead — see below.
const TOOL_WHITELIST: Record<string, string[]> = {
  "co-observer": ["Read", "Glob"],
  "co-rule-user": ["Read", "Grep", "Glob"],
  "co-rule-project": ["Read", "Grep", "Glob"],
  "co-rule-app": ["Read", "Grep", "Glob"],
  "co-planner": ["Read", "Grep", "Glob", "WebFetch", "WebSearch"],
  "co-librarian": ["Read", "Grep", "Glob", "WebFetch", "WebSearch"],
  "co-designer": ["Read", "Edit", "Write", "Glob", "Grep"],
  "co-fixer": ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "TodoWrite"],
};

// Roles with no `tools` field at all: they inherit every tool — including MCP
// tools. A whitelist only ever matches built-in names, so any role behind a
// `tools` list cannot see `co_delegate`, `co_council`, `co_close_job`, or the
// new `co_scan`. Roles that need MCP tool access (co-explorer, co-oracle,
// co-council) therefore skip the whitelist and use `disallowedTools` instead.
// The plugin's own MCP tools are all read-only or harmless, so inheriting them
// is safe for these roles.
const NO_TOOLS_FIELD = new Set(["co-council", "co-explorer", "co-oracle"]);

// Roles that inherit every tool but must blacklist the mutating ones. The
// ZCode parser and Settings UI both honour `disallowedTools`.
const DISALLOWED_TOOLS: Record<string, string[]> = {
  // co-council / co-explorer / co-oracle are read-only by contract; deny
  // everything that writes, spawns, or mutates.
  "co-council": ["Write", "Edit", "ApplyPatch", "Bash", "Agent", "Task"],
  "co-explorer": ["Write", "Edit", "ApplyPatch", "Agent", "Task"],
  "co-oracle": ["Write", "Edit", "ApplyPatch", "Agent", "Task"],
};

interface AgentTemplate {
  name: string;
  fileName: string;
  description: string;
  tools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  body: string;
}

function extractFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const frontmatter: Record<string, string> = {};
  const lines = match[1].split("\n");
  for (const line of lines) {
    const kv = line.match(/^(\w+):\s*(.+)/);
    if (kv) {
      frontmatter[kv[1]] = kv[2].trim();
    }
  }
  return frontmatter;
}

function extractBody(content: string): string {
  // Drop the frontmatter block and the blank line(s) right after it, then
  // normalize the trailing whitespace — the body itself stays verbatim.
  return content
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "")
    .replace(/\s+$/, "");
}

function formatScalar(value: string): string {
  // Keep plain YAML scalars readable; quote only when the value would break.
  const needsQuoting =
    value === "" ||
    value !== value.trim() ||
    /[\r\n]/.test(value) ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    /:\s/.test(value) ||
    /\s#/.test(value);
  return needsQuoting ? JSON.stringify(value) : value;
}

function renderTemplate(agent: AgentTemplate): string {
  const lines = [
    "---",
    `name: ${agent.name}`,
    `description: ${formatScalar(agent.description)}`,
    `model: ${MODEL}`,
  ];

  if (agent.maxTurns !== undefined) {
    lines.push(`maxTurns: ${agent.maxTurns}`);
  }

  if (agent.tools) {
    lines.push(`tools: [${agent.tools.map((tool) => `"${tool}"`).join(", ")}]`);
  }

  if (agent.disallowedTools) {
    lines.push(
      `disallowedTools: [${agent.disallowedTools.map((tool) => `"${tool}"`).join(", ")}]`,
    );
  }

  lines.push("---", "", agent.body, "");
  return lines.join("\n");
}

function buildTemplates(): AgentTemplate[] {
  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  const templates: AgentTemplate[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (EXCLUDED_DIRS.has(entry.name)) continue;

    const skillFile = path.join(SKILLS_DIR, entry.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) {
      console.warn(`⚠ SKILL.md not found for ${entry.name}`);
      continue;
    }

    const content = fs.readFileSync(skillFile, "utf-8");
    const fm = extractFrontmatter(content);
    const rawName = fm.name || entry.name;
    const name = rawName.startsWith("co-") ? rawName : `co-${rawName}`;

    if (EXCLUDED_NAMES.has(name)) continue;

    const tools: string[] | undefined = TOOL_WHITELIST[name];
    if (!tools && !NO_TOOLS_FIELD.has(name)) {
      throw new Error(
        `No tool whitelist for "${name}" — add it to TOOL_WHITELIST (or NO_TOOLS_FIELD) in scripts/generate-agents.ts`,
      );
    }

    templates.push({
      name,
      fileName: `${name}.md`,
      description: fm.description || "",
      tools,
      disallowedTools: DISALLOWED_TOOLS[name],
      maxTurns: MAX_TURNS,
      body: extractBody(content),
    });
  }

  return templates.sort((a, b) => a.name.localeCompare(b.name));
}

function writeTemplates(templates: AgentTemplate[]) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const template of templates) {
    fs.writeFileSync(
      path.join(OUTPUT_DIR, template.fileName),
      renderTemplate(template),
      "utf-8",
    );
  }

  console.log(`✅ Generated ${templates.length} agent templates → ${OUTPUT_DIR}`);
}

function printDiff(expected: string, actual: string, maxLines = 20) {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const total = Math.max(expectedLines.length, actualLines.length);
  let shown = 0;

  for (let i = 0; i < total && shown < maxLines; i++) {
    const exp = i < expectedLines.length ? expectedLines[i] : "<无>";
    const act = i < actualLines.length ? actualLines[i] : "<无>";
    if (exp === act) continue;

    console.error(`    L${i + 1} 期望: ${exp}`);
    console.error(`    L${i + 1} 实际: ${act}`);
    shown++;
  }

  if (shown >= maxLines) {
    console.error(`    … 差异未全部显示（上限 ${maxLines} 行）`);
  }
}

// A plugin-root `agents/` directory is the one fatal mistake this refactor can
// make: it wins over user-scope agents and silently ignores the user's model
// choice. Both --check and the write path must stop on it — writing templates
// while it exists would ship a broken plugin.
function checkPluginAgentsDir(): boolean {
  const forbidden = path.join(PROJECT_ROOT, "agents");
  if (!fs.existsSync(forbidden)) return true;

  console.error(
    `⚠ 检测到插件根目录的 agents/ —— 插件级 agent 优先级高于用户级，会覆盖用户在设置界面选定的模型。`,
  );
  console.error(`  请删除 ${forbidden}，改用 agents-template/。`);
  return false;
}

function checkTemplates(templates: AgentTemplate[]): boolean {
  const expected = new Map(templates.map((t) => [t.fileName, renderTemplate(t)]));
  let driftCount = 0;

  for (const [fileName, content] of expected) {
    const filePath = path.join(OUTPUT_DIR, fileName);

    if (!fs.existsSync(filePath)) {
      console.error(`✗ 缺失模板: ${fileName}`);
      driftCount++;
      continue;
    }

    const actual = fs.readFileSync(filePath, "utf-8");
    if (actual !== content) {
      console.error(`✗ 内容漂移: ${fileName}`);
      printDiff(content, actual);
      driftCount++;
    }
  }

  // Templates left behind by a renamed or removed role.
  if (fs.existsSync(OUTPUT_DIR)) {
    for (const entry of fs.readdirSync(OUTPUT_DIR)) {
      if (entry.endsWith(".md") && !expected.has(entry)) {
        console.error(`✗ 多余模板: ${entry}`);
        driftCount++;
      }
    }
  }

  if (driftCount > 0) {
    console.error(`\n❌ agents-template 与 skills/*/SKILL.md 不一致（${driftCount} 个文件漂移）`);
    console.error(`   运行 bun scripts/generate-agents.ts 重新生成`);
    return false;
  }

  console.log(`✅ agent 模板与 skills 源一致（${templates.length} 个文件）`);
  return true;
}

function main() {
  const checkMode = process.argv.includes("--check");
  const noForbiddenDir = checkPluginAgentsDir();
  const templates = buildTemplates();

  if (checkMode) {
    const inSync = checkTemplates(templates);
    if (!inSync || !noForbiddenDir) {
      process.exit(1);
    }
    return;
  }

  // Write mode (`npm run build` path): a plugin-root agents/ directory outranks
  // user-scope agents, so refuse to generate anything until it is removed.
  if (!noForbiddenDir) {
    process.exit(1);
  }

  writeTemplates(templates);
}

main();
