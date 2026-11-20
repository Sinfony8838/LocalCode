import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Post-edit syntax feedback loop (Cline-style linter awareness): a broken
// edit is reported back to the model immediately instead of surfacing later
// at runtime. JSON is checked inline; the JS family is checked with the same
// runtime the app ships with, via `node --check` (parse only, never executes).
export interface SyntaxDiagnostic { language: 'json' | 'js'; message: string }

export function jsonSyntaxDiagnostic(text: string): SyntaxDiagnostic | null {
  try { JSON.parse(text); return null; }
  catch (error) { return { language: 'json', message: (error as Error).message }; }
}

const JS_EXTENSIONS = new Set(['js', 'mjs', 'cjs']);
export function isJsSyntaxTarget(displayPath: string): boolean {
  return JS_EXTENSIONS.has(displayPath.split('.').pop()?.toLowerCase() ?? '');
}

const CHECK_TIMEOUT_MS = 4000;
const CHECK_OUTPUT_LIMIT = 2000;

async function runSyntaxCheck(target: string, extension: string): Promise<SyntaxDiagnostic | null> {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-syntax-'));
  try {
    // Keep the original extension so ESM/CJS resolution in --check matches the real file.
    const file = path.join(work, `check${extension}`);
    await fs.writeFile(file, target, 'utf8');
    const outcome = await new Promise<{ code: number | null; output: string }>(resolve => {
      let output = '';
      let settled = false;
      const child = spawn(process.execPath, ['--check', file], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, output: output.slice(0, CHECK_OUTPUT_LIMIT) });
      };
      const timer = setTimeout(() => { child.kill(); finish(null); }, CHECK_TIMEOUT_MS);
      child.stdout.on('data', chunk => { output += String(chunk); });
      child.stderr.on('data', chunk => { output += String(chunk); });
      child.on('error', () => finish(null));
      child.on('exit', code => finish(code));
    });
    if (outcome.code === 0) return null;
    const message = outcome.output.trim().split(/\r?\n/).filter(Boolean).pop() ?? '语法解析失败';
    return { language: 'js', message: message.slice(0, 600) };
  } catch {
    return null; // diagnostics are best-effort; never block the edit itself
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** Returns a warning string to append to the tool result, or '' when the content parses. */
export async function postEditSyntaxDiagnostic(displayPath: string, text: string): Promise<string> {
  const extension = displayPath.toLowerCase().endsWith('.json') ? '.json' : `.${displayPath.split('.').pop()?.toLowerCase() ?? ''}`;
  try {
    if (extension === '.json') {
      const diagnostic = jsonSyntaxDiagnostic(text);
      return diagnostic ? `\n[语法检查警告：修改后的 JSON 格式无效（${diagnostic.message}），请立即修复。]` : '';
    }
    if (isJsSyntaxTarget(displayPath)) {
      const diagnostic = await runSyntaxCheck(text, extension);
      return diagnostic ? `\n[语法检查警告：修改后的 JavaScript 无法解析（${diagnostic.message}），请立即修复。]` : '';
    }
  } catch { /* best-effort */ }
  return '';
}
