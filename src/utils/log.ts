/**
 * Simple append-only diagnostic logger.
 *
 * Writes to $TMPDIR/zcode-cohub.log or process.cwd()/.zcode-cohub.log
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const LOG_DIR = process.env.ZCODE_COHUB_LOG_DIR || os.tmpdir();
const LOG_FILE = path.join(LOG_DIR, "zcode-cohub.log");

export function appendLog(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line, "utf-8");
  } catch {
    // Fail silently — logging is best-effort
  }
}

export function getLogPath(): string {
  return LOG_FILE;
}