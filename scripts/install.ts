#!/usr/bin/env bun
/**
 * zcode-cohub 安装脚本 — 按 ZCode 真实插件机制注册插件
 *
 * 注册的 7 处位置（全部相对本机 ZCode CLI 根 `<home>/.zcode/cli`）：
 *
 *   1. 市场清单   plugins/marketplaces/local/marketplace.json       source 必须是相对路径 "./plugin"
 *   2. 插件实体   plugins/marketplaces/local/plugin/                市场解析的实体目录
 *   3. 市场登记   plugins/known_marketplaces.json                   source = { source: "directory", path }
 *   4. 安装记录   plugins/installed_plugins.json                   installPath 指向缓存
 *   5. 启用开关   config.json → plugins.enabledPlugins["zcode-cohub@local"]
 *   6. 插件缓存   plugins/cache/local/zcode-cohub/<version>/
 *   7. 数据目录   plugins/data/zcode-cohub@local
 *
 * 外加第 9 步（与插件机制无关，但决定用户能否在 Settings → Subagents 里逐角色选模型）：
 *
 *   9. 角色 agent  <home>/.zcode/agents/co-*.md   由 agents-template/*.md 铺设
 *
 * 用法：
 *   bun scripts/install.ts [--dev] [--dry-run] [--no-agents] [--force-agents]
 *
 *   --dev           开发模式：非 Windows 平台对组件建 symlink（Windows 上仍为复制）
 *   --dry-run       只打印将要做的变更，不写任何文件（不建目录、不备份）
 *   --no-agents     跳过角色 agent 铺设
 *   --force-agents  全量覆盖角色 agent（连 model 等用户键一起重置为模板值）
 *
 * 约定：
 *   - 所有全局 JSON 按「读 → 就地改 → 写」合并，保留他人条目与未知字段（如 refresh 事务 ID）。
 *   - 写入前备份 `<file>.bak`，已存在 .bak 则不覆盖。
 *   - 幂等：目标内容与源一致时不写文件；时间戳字段（addedAt / installedAt / lastUpdated）
 *     在条目已存在时保持不变。
 *   - 角色 agent 逐键 merge：name / description / tools 与正文由脚本强制更新，
 *     model / thoughtLevel / color / maxTurns / permissionMode / background /
 *     disallowedTools / skills / injectAgentsMd / mcpServers 以目标现值为准
 *     （用户可能在设置界面改过）；frontmatter 解析失败或存在重复键则原样保留并告警
 *     （重复键在 ZCode 的 loose YAML 里是后写胜出，merge 会改变实际生效值，故不 merge）。
 *   - agents-template/ 只是模板源，绝不能进入插件实体与缓存；插件根的 agents/ 目录
 *     会被 ZCode 注册为插件级 agent（优先级高于用户级），脚本会告警并清理。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- 基础环境

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

const argv = process.argv.slice(2);
const isDryRun = argv.includes("--dry-run");
const isDev = argv.includes("--dev");
/** --no-agents 优先于 --force-agents（不铺设就无所谓覆盖） */
const noAgents = argv.includes("--no-agents");
const forceAgents = argv.includes("--force-agents");

if (argv.includes("--help") || argv.includes("-h")) {
  console.log("用法: bun scripts/install.ts [--dev] [--dry-run] [--no-agents] [--force-agents]");
  process.exit(0);
}

const PLUGIN_NAME = "zcode-cohub";
const MARKETPLACE_ID = "local";
const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_ID}`;
/** marketplace.json 中必须写相对路径 —— 写绝对路径或插件名会导致市场解析失败 */
const PLUGIN_SOURCE = "./plugin";
const AUTHOR_NAME = "cjf";

const pkg = JSON.parse(
  fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"),
) as { version: string };
const VERSION: string = pkg.version;

const ZCODE_HOME = process.env.ZCODE_HOME
  ? path.resolve(process.env.ZCODE_HOME)
  : path.join(os.homedir(), ".zcode");
const CLI_ROOT = path.join(ZCODE_HOME, "cli");
const PLUGINS_ROOT = path.join(CLI_ROOT, "plugins");

const MARKETPLACE_DIR = path.join(PLUGINS_ROOT, "marketplaces", MARKETPLACE_ID);
const MARKETPLACE_JSON = path.join(MARKETPLACE_DIR, "marketplace.json");
/** 插件实体：必须位于 <marketplace 目录>/plugin/ */
const ENTITY_DIR = path.join(MARKETPLACE_DIR, "plugin");
const KNOWN_MARKETPLACES_JSON = path.join(PLUGINS_ROOT, "known_marketplaces.json");
const INSTALLED_PLUGINS_JSON = path.join(PLUGINS_ROOT, "installed_plugins.json");
const CLI_CONFIG_JSON = path.join(CLI_ROOT, "config.json");
const CACHE_DIR = path.join(PLUGINS_ROOT, "cache", MARKETPLACE_ID, PLUGIN_NAME, VERSION);
const DATA_DIR = path.join(PLUGINS_ROOT, "data", PLUGIN_ID);
/** 旧脚本遗留的无效数据目录（无 consumer） */
const LEGACY_DATA_DIR = path.join(ZCODE_HOME, "data", PLUGIN_NAME);
/** 用户级角色 agent 目录（Settings → Subagents 读取此处；与 ZCODE_HOME 覆盖逻辑一致） */
const AGENTS_DIR = path.join(ZCODE_HOME, "agents");
/** 角色 agent 模板源（仅安装器读取，绝不随插件发布） */
const AGENTS_TEMPLATE_DIR = path.join(PROJECT_ROOT, "agents-template");

/** 插件载荷（相对 PROJECT_ROOT）—— 实体目录与缓存目录内容相同 */
const PAYLOAD = [".zcode-plugin", "skills", "hooks", "dist", "package.json"];
/**
 * 绝不进入插件实体/缓存的目录：
 *   agents/          ZCode 会把插件根的 agents/ 注册为「插件级 agent」，优先级高于用户级，
 *                    从而覆盖用户在 Settings → Subagents 里选定的模型 —— 必须避免。
 *   agents-template/ 仅是安装器的模板输入，插件包里带着纯属冗余。
 */
const NEVER_SHIP = ["agents", "agents-template"];
/** 目录同步时永不删除的文件名 */
const PRESERVE = new Set([".zcode-plugin-seed.json"]);

const DEFAULT_PLUGIN_DESC = "ZCode 中文智能体编排插件 — 12 个专职 skill + delegate/council MCP 工具";
const DEFAULT_MARKETPLACE_DESC = `Local development marketplace for ${PLUGIN_NAME}`;

// ---------------------------------------------------------------- 输出与统计

let changeCount = 0;

function step(n: number, total: number, title: string): void {
  console.log(`\n[${n}/${total}] ${title}`);
}

function line(msg: string): void {
  console.log(`      ${msg}`);
}

/** 记录一处变更（dry-run 下为「将要发生」） */
function mark(msg: string): void {
  changeCount++;
  console.log(`      + ${msg}`);
}

function nop(msg: string): void {
  console.log(`      = ${msg}`);
}

function warn(msg: string): void {
  console.log(`      ! ${msg}`);
}

// ---------------------------------------------------------------- 文件系统工具

function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function ensureDir(dir: string): void {
  if (!exists(dir) && !isDryRun) fs.mkdirSync(dir, { recursive: true });
}

function hashFile(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sameContent(a: string, b: string): boolean {
  const sa = fs.statSync(a);
  const sb = fs.statSync(b);
  if (sa.isDirectory() !== sb.isDirectory()) return false;
  if (sa.isDirectory()) return true;
  if (!sa.isFile() || !sb.isFile()) return false;
  if (sa.size !== sb.size) return false;
  return hashFile(a) === hashFile(b);
}

interface SyncStat {
  copied: number;
  removed: number;
  same: number;
  linked: number;
  samples: string[];
}

function newStat(): SyncStat {
  return { copied: 0, removed: 0, same: 0, linked: 0, samples: [] };
}

function sample(stat: SyncStat, rel: string): void {
  if (stat.samples.length < 6) stat.samples.push(rel);
}

/** 递归镜像目录/文件；内容一致则跳过（保证幂等），并清理目标端多余条目 */
function mirror(src: string, dest: string, rel: string, stat: SyncStat): void {
  const srcStat = fs.statSync(src);
  const destExists = exists(dest);

  if (srcStat.isDirectory()) {
    if (destExists && !fs.statSync(dest).isDirectory()) {
      if (!isDryRun) fs.rmSync(dest, { recursive: true, force: true });
      warn(`目标非目录，将替换: ${rel}`);
    } else if (!destExists) {
      ensureDir(dest);
    }
    for (const name of fs.readdirSync(src)) {
      mirror(path.join(src, name), path.join(dest, name), rel ? `${rel}/${name}` : name, stat);
    }
    // 清理源中已不存在的残留（避免旧 skill / 旧产物残留生效）
    if (destExists) {
      for (const name of fs.readdirSync(dest)) {
        if (PRESERVE.has(name)) continue;
        if (fs.existsSync(path.join(src, name))) continue;
        if (!isDryRun) fs.rmSync(path.join(dest, name), { recursive: true, force: true });
        stat.removed++;
        sample(stat, rel ? `${rel}/${name}` : name);
      }
    }
    return;
  }

  if (destExists && sameContent(src, dest)) {
    stat.same++;
    return;
  }
  if (!isDryRun) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  stat.copied++;
  sample(stat, rel);
}

/**
 * 清理根目录下不属于插件载荷的残留（旧脚本遗留文件等）。
 * PAYLOAD 之外的条目一律视为残留，PRESERVE 中的文件保留；
 * NEVER_SHIP 中的 agent 目录额外打印告警（它们会覆盖用户级 agent 设置）。
 */
function pruneRoot(dir: string, stat: SyncStat): void {
  if (!exists(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (PRESERVE.has(name)) continue;
    const forbidden = NEVER_SHIP.includes(name);
    if (!forbidden && PAYLOAD.includes(name)) continue;
    if (!isDryRun) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    stat.removed++;
    sample(stat, name);
    if (forbidden) {
      warn(`清理插件目录中的 ${name}/ —— 插件级 agent 优先级高于用户级，会覆盖用户选定的模型`);
    }
  }
}

function reportSync(label: string, dest: string, stat: SyncStat): void {
  const parts: string[] = [];
  if (stat.linked) parts.push(`链接 ${stat.linked} 项`);
  if (stat.copied) parts.push(`复制 ${stat.copied} 个文件`);
  if (stat.removed) parts.push(`清理 ${stat.removed} 个残留`);
  if (stat.same) parts.push(`跳过 ${stat.same} 个未变文件`);

  if (stat.copied || stat.removed || stat.linked) {
    mark(`${label} → ${dest}`);
    line(`  ${parts.join("，")}`);
    if (stat.samples.length) {
      const more = stat.copied + stat.removed > stat.samples.length ? " …" : "";
      line(`  示例: ${stat.samples.join(", ")}${more}`);
    }
  } else {
    nop(`${label} 已是最新（${parts.join("，") || "无文件"}）`);
  }
}

/** --dev：非 Windows 平台用 symlink 指向源码，便于立刻生效 */
function linkDir(src: string, dest: string, stat: SyncStat): void {
  if (isSymlink(dest) && fs.readlinkSync(dest) === src) {
    stat.same++;
    return;
  }
  if (!isDryRun) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.symlinkSync(src, dest, "junction");
  }
  stat.linked++;
  sample(stat, path.basename(dest));
}

// ---------------------------------------------------------------- JSON 合并工具

function readJson(file: string): { raw: string | null; data: any } {
  if (!exists(file)) return { raw: null, data: null };
  const raw = fs.readFileSync(file, "utf-8");
  if (raw.trim() === "") return { raw, data: null };
  try {
    return { raw, data: JSON.parse(raw) };
  } catch (err) {
    throw new Error(`拒绝覆盖（JSON 解析失败）: ${file}\n  ${(err as Error).message}`);
  }
}

/** 备份为 <file>.bak；已存在则不覆盖 */
function backupFile(file: string): void {
  if (isDryRun) return;
  const bak = `${file}.bak`;
  if (exists(bak)) return;
  if (exists(file)) fs.copyFileSync(file, bak);
}

/**
 * 读 → 就地改 → 写。就地修改可保留原文件的键顺序与未知字段（他人条目、ZCode 事务 ID）。
 * 换行符跟随原文件（ZCode 写的文件可能是 CRLF）。
 * 内容无变化时不写文件、不备份。返回是否发生变更。
 */
function updateJson(file: string, mutate: (data: any) => void): boolean {
  const { raw, data } = readJson(file);
  const next = data ?? {};
  mutate(next);

  const eol = raw && raw.includes("\r\n") ? "\r\n" : "\n";
  const nextRaw = JSON.stringify(next, null, 2).split("\n").join(eol) + eol;
  const prevRaw = raw === null || raw.trim() === "" ? null : raw.endsWith(eol) ? raw : raw + eol;

  if (prevRaw !== null && prevRaw === nextRaw) return false;

  if (!isDryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    backupFile(file);
    fs.writeFileSync(file, nextRaw, "utf-8");
  }
  return true;
}

function normPath(p: unknown): string {
  return String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

// ---------------------------------------------------------------- agent 模板工具

/** 脚本管理键：每次安装都以模板值强制更新 */
const MANAGED_AGENT_KEYS = new Set(["name", "description", "tools"]);

/**
 * 用户键：目标文件中存在即保留现值（用户可能在 Settings → Subagents 里改过，
 * 绝不能被模板覆盖）；目标缺失该键时才补模板值。
 * 清单对齐 ZCode subagent frontmatter 真实会写入的键：memory 并不存在（已移除），
 * disallowedTools / skills / injectAgentsMd / mcpServers 才是设置界面会写的键。
 */
const USER_AGENT_KEYS = new Set([
  "model",
  "thoughtLevel",
  "color",
  "maxTurns",
  "permissionMode",
  "background",
  "disallowedTools",
  "skills",
  "injectAgentsMd",
  "mcpServers",
]);

/** frontmatter 中的一个键块：键行 + 其续行（缩进块序列 / 列表项 / 块内注释） */
interface FmBlock {
  key: string;
  lines: string[];
}

interface ParsedAgent {
  blocks: FmBlock[];
  map: Map<string, FmBlock>;
  /** 首个键之前的注释行 / 空行 —— 原样保留并输出（ZCode 的解析器同样会跳过注释） */
  prelude: string[];
  body: string;
}

/**
 * 解析结果。ok=false 时调用方走「原样保留 + 告警」，绝不半成品写回：
 * 宁可少更新，也不改变文件实际生效的值。
 */
type AgentParseResult = { ok: true; agent: ParsedAgent } | { ok: false; reason: string };

function blockValue(block: FmBlock): string {
  const m = block.lines[0].match(/^[A-Za-z_][A-Za-z0-9_-]*\s*:\s*(.*)$/);
  return m ? m[1].trim() : "";
}

/** 正文 = 去掉 frontmatter 块，再去掉首尾空白 */
function extractAgentBody(content: string): string {
  return content
    .replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n*/, "")
    .replace(/\s+$/, "");
}

/**
 * 解析 `---` frontmatter。遇到无法可靠解析的内容返回 ok=false，
 * 调用方据此「原样保留 + 告警」—— 宁可少更新，也绝不破坏用户文件。
 */
function parseAgent(content: string): AgentParseResult {
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return { ok: false, reason: "缺少 --- frontmatter 块" };

  const blocks: FmBlock[] = [];
  const map = new Map<string, FmBlock>();
  const prelude: string[] = [];
  let current: FmBlock | null = null;

  for (const raw of match[1].split(/\r?\n/)) {
    const kv = raw.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (kv) {
      // 重复键：ZCode 的 loose YAML 后写胜出，而逐键 merge 只会保留「第一次」的值
      // —— 会改变实际生效值，因此直接放弃 merge（保留原文件 + 告警）。
      if (map.has(kv[1])) return { ok: false, reason: `存在重复键 ${kv[1]}` };
      current = { key: kv[1], lines: [raw] };
      blocks.push(current);
      map.set(current.key, current);
      continue;
    }
    // 空行 / 缩进续行 / 块序列列表项 / 块内注释 → 一律归属当前键
    if (
      current &&
      (raw.trim() === "" ||
        /^[ \t]/.test(raw) ||
        /^-\s/.test(raw) ||
        raw.trimStart().startsWith("#"))
    ) {
      current.lines.push(raw);
      continue;
    }
    // 首个键之前的空行与注释行：作为 prelude 收集，merge 时原样保留并输出
    // （旧实现只放行空行，首行是注释的 agent 会被永久放弃更新）
    if (!current && (raw.trim() === "" || raw.trimStart().startsWith("#"))) {
      prelude.push(raw);
      continue;
    }
    return { ok: false, reason: "含无法解析的内容" }; // 非 YAML 的脏内容 → 解析失败
  }

  if (blocks.length === 0) return { ok: false, reason: "frontmatter 中没有任何键" };
  return { ok: true, agent: { blocks, map, prelude, body: extractAgentBody(content) } };
}

/** 目标正文与模板正文是否不同（不同即意味着本次写入会覆盖自定义正文） */
function bodyDiffers(targetRaw: string, templateRaw: string): boolean {
  return extractAgentBody(targetRaw) !== extractAgentBody(templateRaw);
}

/**
 * 逐键 merge：管理键（name / description / tools）与正文用模板值强制更新；
 * 用户键（USER_AGENT_KEYS）与模板未定义的未知键保留目标现值。
 * ok=false 表示目标 frontmatter 无法可靠解析（调用方保留原文件 + 告警）。
 */
function mergeAgent(
  template: ParsedAgent,
  targetRaw: string,
): { ok: true; content: string; kept: string[] } | { ok: false; reason: string } {
  const parsed = parseAgent(targetRaw);
  if (!parsed.ok) return parsed;
  const target = parsed.agent;

  // 换行符跟随目标文件（ZCode / 用户在 Windows 上可能写成 CRLF）
  const eol = targetRaw.includes("\r\n") ? "\r\n" : "\n";
  const out: string[] = [];
  const emitted = new Set<string>();
  const kept: string[] = [];

  // 0. 首个键之前的注释行 / 空行：原样保留（用户可能在顶部写了自己的说明）。
  //    目标没有 prelude 时才用模板的 prelude，避免模板头部注释被 merge 丢掉。
  out.push(...(target.prelude.length ? target.prelude : template.prelude));

  // 1. 模板顺序：管理键用模板值；用户键若目标存在则用目标值
  for (const block of template.blocks) {
    emitted.add(block.key);
    if (MANAGED_AGENT_KEYS.has(block.key)) {
      out.push(...block.lines);
      continue;
    }
    const user = target.map.get(block.key);
    if (user) {
      out.push(...user.lines);
      const templateValue = blockValue(block);
      const userValue = blockValue(user);
      if (userValue !== templateValue) kept.push(`${block.key}=${userValue}`);
    } else {
      out.push(...block.lines);
    }
  }

  // 2. 目标独有键（用户键 / 未来 ZCode 新键）—— 原样保留，顺序不变
  for (const block of target.blocks) {
    if (emitted.has(block.key)) continue;
    emitted.add(block.key);
    out.push(...block.lines);
    const value = blockValue(block);
    const tag = USER_AGENT_KEYS.has(block.key) ? "" : " (未知键)";
    kept.push(`${block.key}${value ? `=${value}` : ""}${tag}`);
  }

  return {
    ok: true,
    content: `---${eol}${out.join(eol)}${eol}---${eol}${eol}${template.body}${eol}`,
    kept,
  };
}

// ---------------------------------------------------------------- 开场

const TOTAL_STEPS = 9;

console.log(`\nzcode-cohub 安装器 v${VERSION}`);
console.log(`   模式: ${isDev ? "开发 (dev)" : "安装 (install)"}${isDryRun ? "  [DRY-RUN — 不写入任何文件]" : ""}`);
console.log(`   源码: ${PROJECT_ROOT}`);
console.log(`   ZCode CLI: ${CLI_ROOT}`);

// ---------------------------------------------------------------- 1. 载荷检查

step(1, TOTAL_STEPS, "载荷检查");
// 反向护栏①：插件根的 agents/ 会被 ZCode 注册为插件级 agent（优先级高于用户级），
// 静默覆盖用户在 Settings → Subagents 里选定的模型 —— 必须不存在。
const pluginAgentsDir = path.join(PROJECT_ROOT, "agents");
if (exists(pluginAgentsDir)) {
  warn("插件根存在 agents/ —— ZCode 会把它注册为插件级 agent，优先级高于用户级，");
  warn("  会覆盖用户在 Settings → Subagents 选定的模型。请删除，改用 agents-template/：");
  warn(`  ${pluginAgentsDir}`);
} else {
  nop("插件根无 agents/（避免插件级 agent 覆盖用户级设置）");
}
// 反向护栏②：agent 目录绝不能进入载荷（模板源随插件发布纯属冗余）
for (const name of NEVER_SHIP) {
  const idx = PAYLOAD.indexOf(name);
  if (idx >= 0) {
    PAYLOAD.splice(idx, 1);
    warn(`PAYLOAD 不应包含 ${name}，已从载荷移除`);
  }
}
const templateFiles = exists(AGENTS_TEMPLATE_DIR)
  ? fs.readdirSync(AGENTS_TEMPLATE_DIR).filter((f) => f.endsWith(".md")).length
  : 0;
line(
  templateFiles > 0
    ? `agent 模板: agents-template/（${templateFiles} 个，仅铺设到用户目录，不进插件包）`
    : `agent 模板: agents-template/ 不存在或为空（将跳过第 9 步铺设）`,
);

const present = PAYLOAD.filter((c) => exists(path.join(PROJECT_ROOT, c)));
const missing = PAYLOAD.filter((c) => !present.includes(c));
line(`组件: ${present.join(", ")}`);
if (missing.length) warn(`缺失（将跳过）: ${missing.join(", ")}`);
if (!exists(path.join(PROJECT_ROOT, "dist", "src", "index.js"))) {
  warn("dist/src/index.js 不存在 —— MCP server 无法启动，请先运行 npm run build");
}

// ---------------------------------------------------------------- 2. 插件实体

step(2, TOTAL_STEPS, `插件实体 (${path.relative(CLI_ROOT, ENTITY_DIR)})`);
ensureDir(ENTITY_DIR);
{
  const stat = newStat();
  for (const comp of present) {
    const src = path.join(PROJECT_ROOT, comp);
    const dest = path.join(ENTITY_DIR, comp);
    if (isDev && process.platform !== "win32" && fs.statSync(src).isDirectory()) {
      linkDir(src, dest, stat);
    } else {
      mirror(src, dest, comp, stat);
    }
  }
  pruneRoot(ENTITY_DIR, stat);
  reportSync("实体目录", ENTITY_DIR, stat);
}

// ---------------------------------------------------------------- 3. 插件缓存

step(3, TOTAL_STEPS, `插件缓存 (${path.relative(CLI_ROOT, CACHE_DIR)})`);
ensureDir(CACHE_DIR);
{
  const stat = newStat();
  for (const comp of present) {
    const src = path.join(PROJECT_ROOT, comp);
    const dest = path.join(CACHE_DIR, comp);
    if (isDev && process.platform !== "win32" && fs.statSync(src).isDirectory()) {
      linkDir(src, dest, stat);
    } else {
      mirror(src, dest, comp, stat);
    }
  }
  pruneRoot(CACHE_DIR, stat);
  reportSync("插件缓存", CACHE_DIR, stat);

  // seed 标记（可选，不影响机制；保留写入）
  const seedFile = path.join(CACHE_DIR, ".zcode-plugin-seed.json");
  const seed = {
    marketplace: MARKETPLACE_ID,
    name: PLUGIN_NAME,
    version: VERSION,
    installedAt: new Date().toISOString(),
  };
  if (exists(seedFile)) {
    nop(".zcode-plugin-seed.json 已存在（保留原文件）");
  } else {
    if (!isDryRun) fs.writeFileSync(seedFile, `${JSON.stringify(seed, null, 2)}\n`, "utf-8");
    mark(".zcode-plugin-seed.json");
  }
}

// ---------------------------------------------------------------- 4. 市场清单

step(4, TOTAL_STEPS, `市场清单 (${path.relative(CLI_ROOT, MARKETPLACE_JSON)})`);
ensureDir(MARKETPLACE_DIR);
const marketplaceChanged = updateJson(MARKETPLACE_JSON, (data) => {
  if (!data.name) data.name = MARKETPLACE_ID;
  if (!data.description) data.description = DEFAULT_MARKETPLACE_DESC;
  if (!data.owner || typeof data.owner !== "object") data.owner = { name: AUTHOR_NAME };
  if (!Array.isArray(data.plugins)) data.plugins = [];

  const idx = data.plugins.findIndex((p: any) => p && p.name === PLUGIN_NAME);
  if (idx >= 0) {
    const entry = data.plugins[idx];
    entry.name = PLUGIN_NAME;
    entry.source = PLUGIN_SOURCE;
    entry.version = VERSION;
    if (!entry.description) entry.description = DEFAULT_PLUGIN_DESC;
    if (!entry.author || typeof entry.author !== "object") entry.author = { name: AUTHOR_NAME };
    if (!entry.category) entry.category = "developer-tools";
    // 旧脚本误写的绝对路径字段会导致市场解析失败
    delete entry.path;
    delete entry.installPath;
    delete entry.marketplace;
  } else {
    data.plugins.push({
      name: PLUGIN_NAME,
      source: PLUGIN_SOURCE,
      description: DEFAULT_PLUGIN_DESC,
      version: VERSION,
      author: { name: AUTHOR_NAME },
      category: "developer-tools",
    });
  }
});
const pluginCount = (() => {
  try {
    const d = JSON.parse(fs.readFileSync(MARKETPLACE_JSON, "utf-8"));
    return Array.isArray(d.plugins) ? d.plugins.length : 0;
  } catch {
    return 1;
  }
})();
if (marketplaceChanged) mark(`已更新（source="${PLUGIN_SOURCE}", version=${VERSION}）`);
else nop(`已是最新（plugins 共 ${pluginCount} 项）`);

// ---------------------------------------------------------------- 5. 市场登记

step(5, TOTAL_STEPS, `市场登记 (${path.relative(CLI_ROOT, KNOWN_MARKETPLACES_JSON)})`);
const knownChanged = updateJson(KNOWN_MARKETPLACES_JSON, (data) => {
  if (typeof data.version !== "number") data.version = 1;
  if (!Array.isArray(data.marketplaces)) data.marketplaces = [];

  const now = new Date().toISOString();
  const idx = data.marketplaces.findIndex((m: any) => m && m.id === MARKETPLACE_ID);
  if (idx >= 0) {
    const m = data.marketplaces[idx];
    // 就地赋值：保留 addedAt / lastUpdated / cacheTransactionId 等 ZCode 字段与键顺序
    m.id = MARKETPLACE_ID;
    m.source = { source: "directory", path: MARKETPLACE_DIR };
    if (!m.name) m.name = MARKETPLACE_ID;
    if (!m.description) m.description = DEFAULT_MARKETPLACE_DESC;
    if (!m.addedAt) m.addedAt = now;
    if (!m.lastUpdated) m.lastUpdated = now;
    m.pluginCount = pluginCount;
  } else {
    data.marketplaces.push({
      id: MARKETPLACE_ID,
      source: { source: "directory", path: MARKETPLACE_DIR },
      name: MARKETPLACE_ID,
      description: DEFAULT_MARKETPLACE_DESC,
      addedAt: now,
      pluginCount,
      lastUpdated: now,
    });
  }
});
if (knownChanged) mark(`已登记 ${MARKETPLACE_ID} (directory → ${MARKETPLACE_DIR})`);
else nop(`已登记且无变化 (pluginCount=${pluginCount})`);

// ---------------------------------------------------------------- 6. 安装记录

step(6, TOTAL_STEPS, `安装记录 (${path.relative(CLI_ROOT, INSTALLED_PLUGINS_JSON)})`);
const installedChanged = updateJson(INSTALLED_PLUGINS_JSON, (data) => {
  if (typeof data.version !== "number") data.version = 1;
  if (!data.plugins || typeof data.plugins !== "object" || Array.isArray(data.plugins)) {
    data.plugins = {};
  }
  const list: any[] = Array.isArray(data.plugins[PLUGIN_ID]) ? data.plugins[PLUGIN_ID] : (data.plugins[PLUGIN_ID] = []);

  const now = new Date().toISOString();
  const idx = list.findIndex((e: any) => e && (e.id === PLUGIN_ID || (!e.id && e.name === PLUGIN_NAME)));
  if (idx >= 0) {
    const entry = list[idx];
    // 版本与路径都没变时保留原 installedAt，保证重复安装不产生无意义变更
    const sameTarget = entry.version === VERSION && normPath(entry.installPath) === normPath(CACHE_DIR);
    entry.id = PLUGIN_ID;
    entry.name = PLUGIN_NAME;
    entry.marketplace = MARKETPLACE_ID;
    entry.version = VERSION;
    entry.installPath = CACHE_DIR;
    if (!sameTarget || !entry.installedAt) entry.installedAt = now;
    if (!entry.scope) entry.scope = "user";
  } else {
    list.push({
      id: PLUGIN_ID,
      name: PLUGIN_NAME,
      marketplace: MARKETPLACE_ID,
      version: VERSION,
      installPath: CACHE_DIR,
      installedAt: now,
      scope: "user",
    });
  }
});
if (installedChanged) mark(`已记录 ${PLUGIN_ID} → ${CACHE_DIR}`);
else nop(`已记录且无变化 (v${VERSION})`);

// ---------------------------------------------------------------- 7. 启用开关

step(7, TOTAL_STEPS, `启用开关 (${path.relative(CLI_ROOT, CLI_CONFIG_JSON)} → plugins.enabledPlugins)`);
const configChanged = updateJson(CLI_CONFIG_JSON, (data) => {
  if (!data.plugins || typeof data.plugins !== "object") data.plugins = {};
  if (!data.plugins.enabledPlugins || typeof data.plugins.enabledPlugins !== "object") {
    data.plugins.enabledPlugins = {};
  }
  data.plugins.enabledPlugins[PLUGIN_ID] = true;
});
if (configChanged) mark(`已启用 ${PLUGIN_ID}`);
else nop(`已启用 ${PLUGIN_ID}（无变化）`);

// ---------------------------------------------------------------- 8. 数据目录

step(8, TOTAL_STEPS, "数据目录");
if (exists(DATA_DIR)) {
  nop(`已存在 ${DATA_DIR}`);
} else {
  ensureDir(DATA_DIR);
  mark(`创建 ${DATA_DIR}`);
}

if (exists(LEGACY_DATA_DIR)) {
  const children = fs.readdirSync(LEGACY_DATA_DIR);
  if (children.length === 0) {
    if (!isDryRun) fs.rmdirSync(LEGACY_DATA_DIR);
    mark(`清理旧脚本遗留的空目录 ${LEGACY_DATA_DIR}`);
  } else {
    warn(`旧目录非空，未自动删除: ${LEGACY_DATA_DIR}（含 ${children.length} 项）`);
  }
}

// ---------------------------------------------------------------- 9. 角色 agent

step(9, TOTAL_STEPS, `角色 agent (${path.relative(ZCODE_HOME, AGENTS_DIR)})`);
if (noAgents) {
  warn("--no-agents：跳过角色 agent 铺设");
} else if (!exists(AGENTS_TEMPLATE_DIR)) {
  warn(`模板目录不存在，跳过铺设: ${AGENTS_TEMPLATE_DIR}`);
  warn("  运行 bun scripts/generate-agents.ts 生成模板");
} else {
  const templates = fs
    .readdirSync(AGENTS_TEMPLATE_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();

  if (templates.length === 0) {
    warn(`模板目录为空，跳过铺设: ${AGENTS_TEMPLATE_DIR}`);
  } else {
    ensureDir(AGENTS_DIR);
    let created = 0;
    let updated = 0;
    let same = 0;
    let forced = 0;
    const keptNotes: string[] = [];

    for (const file of templates) {
      const srcPath = path.join(AGENTS_TEMPLATE_DIR, file);
      const destPath = path.join(AGENTS_DIR, file);
      const name = file.replace(/\.md$/, "");
      const templateRaw = fs.readFileSync(srcPath, "utf-8");

      // 目标不存在 → 直接写入模板全文
      if (!exists(destPath)) {
        if (!isDryRun) fs.writeFileSync(destPath, templateRaw, "utf-8");
        created++;
        continue;
      }

      // 目标被同名目录占用等异常：跳过，不碰
      if (!fs.statSync(destPath).isFile()) {
        warn(`${name}: 目标是目录而非文件，已跳过（请手工处理 ${destPath}）`);
        continue;
      }

      const targetRaw = fs.readFileSync(destPath, "utf-8");

      // --force-agents：全量覆盖（用户键也重置）
      if (forceAgents) {
        if (targetRaw === templateRaw) {
          same++;
          continue;
        }
        if (bodyDiffers(targetRaw, templateRaw)) {
          line(`${name}: 正文已按模板更新（自定义正文被覆盖，--force-agents 全量覆盖）`);
        }
        if (!isDryRun) fs.writeFileSync(destPath, templateRaw, "utf-8");
        forced++;
        continue;
      }

      // 默认：逐键 merge（用户键保留）
      const parsedTemplate = parseAgent(templateRaw);
      if (!parsedTemplate.ok) {
        warn(`${name}: 模板 frontmatter ${parsedTemplate.reason}，已跳过（未改动目标文件）`);
        continue;
      }
      const merged = mergeAgent(parsedTemplate.agent, targetRaw);
      if (!merged.ok) {
        warn(`${name}: 目标 frontmatter ${merged.reason}，保留原文件不动: ${destPath}`);
        continue;
      }

      // 无论是否写入都要报告被保留的用户设置 —— 用户需要知道自己的选择还活着
      if (merged.kept.length) keptNotes.push(`${name}: 保留用户 ${merged.kept.join(", ")}`);

      if (merged.content === targetRaw) {
        same++;
        continue;
      }
      // 正文被模板覆盖时不再静默（用户在设置界面改过的 system prompt 会丢失）
      if (bodyDiffers(targetRaw, templateRaw)) {
        line(`${name}: 正文已按模板更新（自定义正文被覆盖，--no-agents 可跳过）`);
      }
      if (!isDryRun) fs.writeFileSync(destPath, merged.content, "utf-8");
      updated++;
    }

    if (created || updated || forced) {
      mark(`角色 agent → ${AGENTS_DIR}`);
      line(
        `  新建 ${created} 个，更新 ${updated} 个` +
          (forced ? `，强制覆盖 ${forced} 个（--force-agents）` : "") +
          `，未变 ${same} 个（模板共 ${templates.length} 个）`,
      );
    } else {
      nop(`角色 agent 已是最新（共 ${templates.length} 个模板，未变 ${same} 个）`);
    }

    if (keptNotes.length) {
      line(`保留用户自定义设置（${keptNotes.length} 个角色；--force-agents 可重置为模板值）:`);
      for (const note of keptNotes) line(`  ${note}`);
    }

    if (!forceAgents && !isDryRun) {
      // 用户目录里可能有自己写的其他 agent —— 一个都不碰
      const extra = fs
        .readdirSync(AGENTS_DIR)
        .filter((f) => f.endsWith(".md") && !templates.includes(f));
      if (extra.length) {
        nop(`用户目录中其他 agent 未触碰: ${extra.join(", ")}（${extra.length} 个）`);
      }
    }

    line(`在 ZCode 中打开 Settings → Subagents 可为每个角色单独选择模型`);
  }
}

// ---------------------------------------------------------------- 汇总

console.log(`\n${"=".repeat(60)}`);
if (isDryRun) {
  console.log(`DRY-RUN 结束：共 ${changeCount} 项将要变更，未写入任何文件。`);
  console.log("去掉 --dry-run 即执行实际安装。\n");
} else if (changeCount === 0) {
  console.log("安装完成：所有注册项已是最新，无需改动。请重启 ZCode 加载插件。\n");
} else {
  console.log(`安装完成：共 ${changeCount} 项变更。请重启 ZCode 加载插件。\n`);
  console.log("变更的全局 JSON 已备份为 <file>.bak（若原本不存在）。");
}

if (isDev) {
  console.log("\n开发提示:");
  console.log("   - 修改 skills/*/SKILL.md 后，重启 ZCode 即可生效");
  console.log("   - 修改 src/ 后，运行 npm run build:hooks && npm run build 重新构建");
  console.log(`   - 源码目录: ${PROJECT_ROOT}\n`);
}
