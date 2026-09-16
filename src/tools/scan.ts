/**
 * co_scan MCP Tool -- batch symbol reference scanner.
 *
 * Scans a directory tree for multiple symbol references in a single pass
 * using joint regexes per file batch. This avoids O(symbols x files) scanning
 * cost and replaces the pattern of "one grep per symbol".
 *
 * Performance principle:
 *   Instead of running one grep per symbol (O(n_symbols x n_files)),
 *   we build a single joint regex per batch: \b(Sym1|Sym2|...|SymN)\b
 *   and scan each file once per batch. With batch size ~500, 1158 symbols
 *   become ~3 regex passes per file instead of 1158 separate scans.
 */

import { execFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ===== Types =====

export interface ScanInput {
  symbols: string[];
  root_dir?: string;
  file_patterns?: string[];
  exclude_patterns?: string[];
  max_files?: number;
  max_file_size_bytes?: number;
  include_samples?: boolean;
  count_declarations?: boolean; // true=不跳过声明行，reference_count 恢复为总匹配数；默认 false
  timeout_ms?: number;
}

export interface ScanSymbolResult {
  symbol: string;
  /** 匹配出现次数（已排除声明行，除非 count_declarations=true）。注：是匹配次数而非命中文件数。 */
  reference_count: number;
  /** 被跳过的声明行命中数（仅当 count_declarations=false 时有效）。 */
  declaration_hits: number;
  files: string[];
  sample_lines?: string[];
}

export interface ScanResult {
  success: boolean;
  symbols: ScanSymbolResult[];
  zero_reference_symbols: string[];
  scanned_files: number;
  skipped_files: number;
  truncated: boolean;
  truncation_reason?: string;
  /** truncated=true 时的可靠性警告，提示 zero_reference_symbols 可能不准。 */
  warning?: string;
  elapsed_ms: number;
  error?: string;
}

// ===== Constants =====

const DEFAULT_FILE_PATTERNS = ["**/*.java"];
const DEFAULT_EXCLUDE_PATTERNS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/target/**",
  "**/build/**",
  "**/dist/**",
  "**/out/**",
];
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_FILE_SIZE_BYTES = 512 * 1024; // 512KB
const DEFAULT_TIMEOUT_MS = 60_000;
const FILE_READ_CONCURRENCY = 8;
const MAX_RESULT_FILES = 10;
const MAX_SAMPLE_LINES = 3;
const BATCH_SIZE = 500;

// ===== Helpers =====

/**
 * Cache for compiled glob patterns (Fix 4b micro-optimization).
 */
const globCache = new Map<string, RegExp>();

/**
 * Convert a glob pattern to a RegExp.
 * Supports: ** (multi-directory wildcard), * (single-segment wildcard),
 *           ? (single char), and standard path separators (/ or \).
 */
function globToRegex(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;

  let regexStr = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && i + 1 < pattern.length && pattern[i + 1] === "*") {
      // **/ matches zero or more directory levels
      if (i + 2 < pattern.length && (pattern[i + 2] === "/" || pattern[i + 2] === "\\")) {
        regexStr += "(.*[/\\\\])?";
        i += 3;
      } else {
        // ** at end of pattern
        regexStr += ".*";
        i += 2;
      }
    } else if (ch === "*") {
      regexStr += "[^/\\\\]*";
      i += 1;
    } else if (ch === "?") {
      regexStr += "[^/\\\\]";
      i += 1;
    } else if (ch === ".") {
      regexStr += "\\.";
      i += 1;
    } else {
      // Escape other regex-special characters
      if (/[+^${}()|[\]\\]/.test(ch)) {
        regexStr += "\\" + ch;
      } else {
        regexStr += ch;
      }
      i += 1;
    }
  }
  const result = new RegExp(`^${regexStr}$`);
  globCache.set(pattern, result);
  return result;
}

/**
 * Escape regex special characters in a symbol name.
 * Symbols may contain $ (inner classes), . (packages), etc.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract the simple name (last dot-separated segment) from a qualified symbol. */
function simpleName(symbol: string): string {
  const idx = symbol.lastIndexOf(".");
  return idx >= 0 ? symbol.slice(idx + 1) : symbol;
}

/** Check if a file path (relative to root) matches at least one pattern in the list. */
function matchesAnyGlob(filePath: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((p) => globToRegex(p).test(filePath));
}

// ===== File listing =====

/**
 * List all files under rootDir, returning paths relative to rootDir.
 *
 * Priority: rg --files (fast, skips .gitignore'd dirs natively).
 * Fallback: Node recursive readdir + stat.
 */
/**
 * Normalize a file path returned by `rg --files` to a path relative to rootDir.
 * `rg --files` on Windows returns absolute paths like `C:\dir\src\File.java`;
 * we need `src/File.java` for glob matching.
 */
function toRelativePath(rootDir: string, absPath: string): string {
  // Normalize both to forward slashes
  let normalizedRoot = rootDir.replace(/\\/g, "/");
  let normalizedPath = absPath.replace(/\\/g, "/");

  // Ensure root ends with /
  if (!normalizedRoot.endsWith("/")) normalizedRoot += "/";

  if (normalizedPath.startsWith(normalizedRoot)) {
    return normalizedPath.slice(normalizedRoot.length);
  }
  // Fallback: treat as already relative
  return normalizedPath;
}

async function listFiles(rootDir: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("rg", ["--files", rootDir], {
      timeout: 30_000,
      windowsHide: true,
    });
    return stdout
      .trim()
      .split("\n")
      .filter((s) => s.length > 0)
      .map((f) => toRelativePath(rootDir, f));
  } catch {
    // rg unavailable or failed; fall back to recursive readdir
    return listFilesFallback(rootDir);
  }
}

function listFilesFallback(rootDir: string): string[] {
  const result: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(rootDir, { recursive: true }) as unknown as string[];
  } catch {
    return result;
  }
  for (const entry of entries) {
    const fullPath = join(rootDir, entry.toString());
    try {
      if (statSync(fullPath).isFile()) {
        result.push(entry.toString().replace(/\\/g, "/"));
      }
    } catch {
      // skip unreadable entries
    }
  }
  return result;
}

// ===== Timeout controller =====

/**
 * Simple timeout controller that sets an aborted flag after a delay.
 * Used internally to implement partial-result-on-timeout semantics.
 */
class TimeoutController {
  private _aborted = false;
  private _timer: ReturnType<typeof setTimeout> | null = null;

  constructor(ms: number) {
    if (ms > 0 && ms < Infinity) {
      this._timer = setTimeout(() => {
        this._aborted = true;
      }, ms);
    }
  }

  get aborted(): boolean {
    return this._aborted;
  }

  dispose(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}

// ===== Core scanning =====

/**
 * Result of scanning one file against one batch of symbols.
 */
interface FileScan {
  hits: Map<string, number>;          // simpleName -> hit count in this file (excludes declarations)
  declarationHits: Map<string, number>; // simpleName -> declaration line hits skipped from reference_count
  sampleLines: Map<string, string[]>; // simpleName -> sample lines (up to MAX_SAMPLE_LINES)
}

/**
 * Scan a single file's content against a set of symbol entries.
 *
 * Matching semantics:
 * - Lookbehind/lookahead (?<![\w$]) / (?![\w$]): ensures "Foo" does NOT match
 *   "FooBar" or "someFoo", AND correctly handles "$" prefix ($Foo is distinct).
 * - Case-sensitive: "foo" and "Foo" are distinct.
 * - All occurrences are counted including those in comments, strings,
 *   and import statements. This is a deliberate conservative strategy:
 *   we would rather report a zero-reference symbol as "has references"
 *   than miss any. The caller can always inspect the sample lines to
 *   decide if the reference is meaningful.
 *
 * Declaration skip (Fix 1):
 *   Lines matching a type declaration (class|interface|enum|record|@interface + simpleName)
 *   are excluded from reference_count and counted in declaration_hits instead.
 *   Constructors like "public Foo() {}" are NOT skipped — conservative: it's
 *   better to count a constructor as a reference than mis-report a zero-ref.
 *   Method/field declarations are also NOT skipped (known limitation, noted).
 */
function scanContent(
  content: string,
  entries: { simple: string; escaped: string }[],
  includeSamples: boolean,
  countDeclarations: boolean,
): FileScan {
  const hits = new Map<string, number>();
  const declarationHits = new Map<string, number>();
  const sampleLines = new Map<string, string[]>();

  // Pre-build a map for O(1) lookup (Fix 4a micro-optimization)
  const entriesBySimple = new Map<string, { simple: string; escaped: string }>();
  for (const e of entries) {
    entriesBySimple.set(e.simple, e);
  }

  // Fix 2: Use lookbehind/lookahead instead of \b for $ boundary support
  // (?<![\w$]) matches start — avoids matching "P" in "AP" and "$P" in "some$P"
  // (?![\w$]) matches end — avoids matching "P" in "Pa"
  // NOTE: \\w in template literal is required so \w reaches the regex engine
  const regex = new RegExp(`(?<![\\w$])(${entries.map((e) => e.escaped).join("|")})(?![\\w$])`, "g");

  // Process line by line to map matches back to their source lines
  const lines = content.split("\n");
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(line)) !== null) {
      const matched = m[1];
      // O(1) lookup via Map (Fix 4a)
      const entry = entriesBySimple.get(matched);
      if (!entry) continue; // guard against regex edge cases

      // Fix 1: Check if this match IS a type declaration (keyword + name at this position)
      // Type declaration pattern: keyword + whitespace + simpleName
      // Keywords: class, interface, enum, record, @interface
      // Position-aware: checks text BEFORE match index, not whole line —
      // so "class Foo { public Foo() {} }" correctly skips "class Foo" but keeps "public Foo() {}".
      // NOTE: Constructor declarations (e.g., "public Foo() {}") are intentionally
      // NOT skipped. Field/method declarations also not skipped. This is a known
      // limitation: only top-level type declarations are excluded.
      const isTypeDecl = !countDeclarations &&
        /(?:^|\s)(?:class|interface|enum|record|@interface)\s+$/.test(line.slice(0, m.index));

      if (isTypeDecl) {
        declarationHits.set(entry.simple, (declarationHits.get(entry.simple) || 0) + 1);
      } else {
        hits.set(entry.simple, (hits.get(entry.simple) || 0) + 1);
      }

      if (includeSamples) {
        const samples = sampleLines.get(entry.simple) || [];
        if (samples.length < MAX_SAMPLE_LINES) {
          samples.push(line.trim());
        }
        sampleLines.set(entry.simple, samples);
      }
    }
  }

  return { hits, declarationHits, sampleLines };
}

// ===== Handler =====

interface SymbolEntry {
  original: string;  // original symbol name from input
  simple: string;    // simple name (last segment after dot)
  escaped: string;   // regex-escaped simple name
}

export async function scanHandler(
  input: ScanInput,
  services: { projectDir: string },
): Promise<ScanResult> {
  const startTime = Date.now();

  // Destructure with defaults
  const {
    symbols,
    root_dir = services.projectDir,
    file_patterns = DEFAULT_FILE_PATTERNS,
    exclude_patterns = DEFAULT_EXCLUDE_PATTERNS,
    max_files = DEFAULT_MAX_FILES,
    max_file_size_bytes = DEFAULT_MAX_FILE_SIZE_BYTES,
    include_samples = false,
    timeout_ms = DEFAULT_TIMEOUT_MS,
  } = input;

  // Validate root_dir
  let rootDir = root_dir;
  try {
    if (!statSync(rootDir).isDirectory()) {
      return {
        success: false,
        symbols: [],
        zero_reference_symbols: [],
        scanned_files: 0,
        skipped_files: 0,
        truncated: false,
        elapsed_ms: Date.now() - startTime,
        error: `Not a directory: ${rootDir}`,
      };
    }
  } catch {
    return {
      success: false,
      symbols: [],
      zero_reference_symbols: [],
      scanned_files: 0,
      skipped_files: 0,
      truncated: false,
      elapsed_ms: Date.now() - startTime,
      error: `Directory not found or not accessible: ${rootDir}`,
    };
  }

  // Validate symbols
  if (!symbols || symbols.length === 0) {
    return {
      success: false,
      symbols: [],
      zero_reference_symbols: [],
      scanned_files: 0,
      skipped_files: 0,
      truncated: false,
      elapsed_ms: Date.now() - startTime,
      error: "No symbols provided for scanning",
    };
  }

  // Deduplicate by simple name while preserving input order
  const seenSimple = new Set<string>();
  const entries: SymbolEntry[] = [];
  const symbolOrder: string[] = [];

  for (const sym of symbols) {
    const simple = simpleName(sym);
    const escaped = escapeRegex(simple);
    if (!seenSimple.has(simple)) {
      seenSimple.add(simple);
      entries.push({ original: sym, simple, escaped });
    }
    if (!symbolOrder.includes(sym)) {
      symbolOrder.push(sym);
    }
  }

  // Build a map from simple name to original symbol(s)
  const simpleToOriginals = new Map<string, string[]>();
  for (const sym of symbols) {
    const simple = simpleName(sym);
    const list = simpleToOriginals.get(simple) || [];
    if (!list.includes(sym)) {
      list.push(sym);
    }
    simpleToOriginals.set(simple, list);
  }

  // Set up timeout
  const timeout = new TimeoutController(timeout_ms);

  try {
    // Phase 1: List files
    const allFiles = await listFiles(rootDir);

    // Phase 2: Filter files by include/exclude patterns
    const matchedFiles: string[] = [];
    let skippedByFilter = 0;

    for (const file of allFiles) {
      const normalizedFile = file.replace(/\\/g, "/");

      // Exclude patterns first (faster rejection)
      if (matchesAnyGlob(normalizedFile, exclude_patterns)) {
        skippedByFilter++;
        continue;
      }

      // Include patterns
      if (!matchesAnyGlob(normalizedFile, file_patterns)) {
        skippedByFilter++;
        continue;
      }

      matchedFiles.push(normalizedFile);
    }

    // Apply max_files cap
    const filesToScan = matchedFiles.slice(0, max_files);
    const truncatedByFileLimit = matchedFiles.length > max_files;

    // Phase 3: Build regex batches
    const batches: { entries: SymbolEntry[] }[] = [];
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      batches.push({ entries: entries.slice(i, i + BATCH_SIZE) });
    }

    // Phase 4: Scan files with concurrency control
    const scannedFilePaths: string[] = [];
    let skippedBySizeOrError = 0;

    // Per-symbol aggregation: simpleName -> { count, fileSet, sampleLines, declarationHits }
    const aggHits = new Map<string, number>();
    const aggDeclarationHits = new Map<string, number>();
    const aggFiles = new Map<string, Set<string>>();
    const aggSamples = new Map<string, string[]>();

    let fileIdx = 0;
    while (fileIdx < filesToScan.length && !timeout.aborted) {
      const batch = filesToScan.slice(fileIdx, fileIdx + FILE_READ_CONCURRENCY);
      fileIdx += FILE_READ_CONCURRENCY;

      // Process each file in the batch concurrently
      const batchResults = await Promise.all(
        batch.map(async (file) => {
          const fullPath = join(rootDir, file);

          // Check file size before reading
          try {
            const st = statSync(fullPath);
            if (st.size > max_file_size_bytes) {
              return { file, scanned: false as const };
            }
          } catch {
            // stat failed (permission, deleted, etc.)
            return { file, scanned: false as const };
          }

          // Read file content
          let content: string;
          try {
            content = await readFile(fullPath, "utf-8");
          } catch {
            return { file, scanned: false as const };
          }

          // Run all batch regexes against this file
          const mergedHits = new Map<string, number>();
          const mergedDeclarationHits = new Map<string, number>();
          const mergedSamples = new Map<string, string[]>();

          const countDecl = input.count_declarations === true;
          for (const b of batches) {
            const scan = scanContent(content, b.entries, include_samples || false, countDecl);
            for (const [sym, count] of scan.hits) {
              mergedHits.set(sym, (mergedHits.get(sym) || 0) + count);
            }
            for (const [sym, count] of scan.declarationHits) {
              mergedDeclarationHits.set(sym, (mergedDeclarationHits.get(sym) || 0) + count);
            }
            if (include_samples) {
              for (const [sym, lines] of scan.sampleLines) {
                const existing = mergedSamples.get(sym) || [];
                for (const line of lines) {
                  if (existing.length < MAX_SAMPLE_LINES) {
                    existing.push(line);
                  }
                }
                mergedSamples.set(sym, existing);
              }
            }
          }

          return { file, scanned: true as const, hits: mergedHits, declarationHits: mergedDeclarationHits, sampleLines: mergedSamples };
        }),
      );

      // Merge batch results into aggregates
      for (const r of batchResults) {
        if (!r.scanned) {
          skippedBySizeOrError++;
          continue;
        }
        scannedFilePaths.push(r.file);
        for (const [sym, count] of r.hits) {
          aggHits.set(sym, (aggHits.get(sym) || 0) + count);
          const fileSet = aggFiles.get(sym) || new Set<string>();
          fileSet.add(r.file);
          aggFiles.set(sym, fileSet);
        }
        for (const [sym, count] of r.declarationHits) {
          aggDeclarationHits.set(sym, (aggDeclarationHits.get(sym) || 0) + count);
        }
        if (include_samples) {
          for (const [sym, lines] of r.sampleLines) {
            const existing = aggSamples.get(sym) || [];
            for (const line of lines) {
              if (existing.length < MAX_SAMPLE_LINES) {
                existing.push(line);
              }
            }
            aggSamples.set(sym, existing);
          }
        }
      }
    }

    const truncatedByTimeout = timeout.aborted;
    const truncated = truncatedByFileLimit || truncatedByTimeout;

    let truncationReason: string | undefined;
    if (truncatedByFileLimit && truncatedByTimeout) {
      truncationReason = "max_files_and_timeout";
    } else if (truncatedByFileLimit) {
      truncationReason = "max_files";
    } else if (truncatedByTimeout) {
      truncationReason = "timeout";
    }

    // Phase 5: Build per-original-symbol results preserving input order
    const resultSymbols: ScanSymbolResult[] = [];
    const zeroRefSymbols: string[] = [];

    for (const sym of symbolOrder) {
      const simple = simpleName(sym);
      const count = aggHits.get(simple) || 0;
      const declCount = aggDeclarationHits.get(simple) || 0;
      const fileSet = aggFiles.get(simple);
      const files = fileSet ? [...fileSet].slice(0, MAX_RESULT_FILES) : [];

      if (count === 0) {
        zeroRefSymbols.push(sym);
      }

      const result: ScanSymbolResult = { symbol: sym, reference_count: count, declaration_hits: declCount, files };
      if (include_samples) {
        const samples = aggSamples.get(simple);
        if (samples && samples.length > 0) {
          result.sample_lines = samples;
        }
      }
      resultSymbols.push(result);
    }

    const elapsed = Date.now() - startTime;
    const totalSkipped = skippedByFilter + skippedBySizeOrError;

    let warning: string | undefined;
    if (truncated) {
      warning = "扫描已截断：未能扫描全部匹配文件。zero_reference_symbols 列表可能不完整，" +
        "请勿仅凭此结果判定符号为死代码。建议放宽 max_files 或 timeout_ms 后重试。";
    }

    return {
      success: true,
      symbols: resultSymbols,
      zero_reference_symbols: zeroRefSymbols,
      scanned_files: scannedFilePaths.length,
      skipped_files: totalSkipped,
      truncated,
      truncation_reason: truncationReason,
      warning,
      elapsed_ms: elapsed,
    };
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      symbols: [],
      zero_reference_symbols: [],
      scanned_files: 0,
      skipped_files: 0,
      truncated: false,
      elapsed_ms: elapsed,
      error: `Scan failed: ${message}`,
    };
  } finally {
    timeout.dispose();
  }
}

// ===== Tool definition =====

export function createScanTool() {
  return {
    name: "co_scan",
    description:
      "批量符号引用扫描器。在一次扫描中同时统计多个符号在源码树中的引用次数，" +
      "使用联合正则每文件只匹配一次，避免 O(符号数 x 文件数) 的线性开销。",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbols: {
          type: "array",
          items: { type: "string" },
          description: "待查符号名列表。支持带包名的全限定名（如 com.example.Foo），内部提取简名匹配。",
        },
        root_dir: {
          type: "string",
          description: "扫描根目录。缺省时用 projectDir。",
        },
        file_patterns: {
          type: "array",
          items: { type: "string" },
          description: "文件包含模式（glob），默认 ['**/*.java']",
        },
        exclude_patterns: {
          type: "array",
          items: { type: "string" },
          description: "文件排除模式（glob），默认排除 node_modules/.git/target/build/dist/out",
        },
        max_files: {
          type: "number",
          description: "最多扫描文件数，默认 5000",
        },
        max_file_size_bytes: {
          type: "number",
          description: "文件大小上限（字节），超限跳过，默认 512KB",
        },
        include_samples: {
          type: "boolean",
          description: "是否返回样本命中行（每符号最多 3 行），默认 false",
        },
        timeout_ms: {
          type: "number",
          description: "内部超时（毫秒），超时后返回已收集的部分结果，默认 60000",
        },
        count_declarations: {
          type: "boolean",
          description: "true 时不跳过类型声明行，reference_count 恢复为总匹配数（含声明行）；默认 false（排除声明行）。",
        },
      },
      required: ["symbols"],
    },
  };
}