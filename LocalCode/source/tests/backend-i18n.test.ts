import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { translations } from '../src/shared/i18n';

/**
 * Backend files whose Chinese messages reach the interface (IPC errors shown
 * with t(), approval and goal reasons, session errors, notices, dialogs).
 * Model-facing files (agent prompts, tool descriptions and tool results in
 * src/agent/engine.ts, src/agent/tools.ts, src/core/workspace.ts, goals.ts)
 * are deliberately excluded: those strings are instructions to the model.
 */
const userFacingFiles = [
  'src/main/main.ts', 'src/main/attachments.ts', 'src/main/pets.ts', 'src/main/store.ts', 'src/main/artifacts.ts',
  'src/core/pet-library.ts', 'src/core/resources.ts', 'src/core/workspace-context.ts', 'src/core/permissions.ts', 'src/core/artifacts.ts',
  'src/core/command.ts', 'src/core/run-changes.ts', 'src/agent/skills.ts', 'src/shared/session-events.ts',
];
/** Chinese literals in those files that are intentionally not translated, with the reason. */
const intentionallyUntranslated: Record<string, string> = {
  '[密钥已隐藏]': 'redaction marker written into logs and model-visible text',
  '请根据附件内容帮助我。': 'default prompt sent to the model when a message has only attachments',
  '附件任务': 'stored default conversation title (user data)',
  'LocalCode 启动失败': 'native dialog shown before settings (and the language) can be read',
  'LocalCode 无法启动：文件夹不可写': 'native dialog shown before settings (and the language) can be read',
  'LocalCode 日志不可写': 'native dialog shown when storage is failing; settings may be unreadable',
  '\n[界面输出截断；完整观察输出见日志。]': 'appended to command output that is also returned to the model',
  '\n[输出超过 8MiB，命令已终止；日志保留截至限制前的输出。]': 'appended to command output that is also returned to the model',
  ' 非文本、大文件和链接不在自动文本统计范围内。': 'suffix concatenated onto another coverage note',
  '本轮文件快照格式无效': 'internal integrity error recorded in logs',
  '超时': 'value interpolated into a log-only diagnostic',
};
/** Model-facing instructions that live in user-facing files. */
const modelFacingPrefixes = ['\n可用内置 Skill：'];
/**
 * Interpolated Chinese templates that remain untranslated after review:
 * prompts sent to the model, tool-result diagnostics returned to the model,
 * and errors that embed system detail. A new template must be added here
 * deliberately (or turned into a translate() key with {placeholders}).
 */
const reviewedTemplates = [
  'src/main/main.ts: `请实施以下已确认的计划：\\n${plan.text}`',
  'src/main/artifacts.ts: `无法打开文件：${error}`',
  'src/core/pet-library.ts: `所选文件不是有效文件，或超过 ${Math.ceil(limit / 1024)} KiB。`',
  'src/core/pet-library.ts: `自定义宠物库无法读取，原文件已保留：${error.message}`',
  'src/core/command.ts: `无法检查 Windows PowerShell：${executable}。请检查文件访问权限后重试；命令尚未执行。`',
  'src/core/command.ts: `未找到 Windows PowerShell 5.1：${executable}。请启用或修复 Windows 自带的 Windows PowerShell ',
  "src/core/command.ts: `无法核验遗留命令进程，未按未验证的 PID 终止进程。（核验退出码：${response.code ?? '超时'}）`",
  'src/core/command.ts: `无法终止已验证的遗留命令进程 ${record.pid}；保留所属记录供下次清理。`',
  'src/agent/skills.ts: `Skill: create-desktop-pet\\n资源: ${resources[resource]}\\n脚本绝对路径: ${script}\\nPower',
];
const cjk = /[\u3400-\u9fff]/;

/**
 * Minimal TypeScript literal scanner (the project uses the native TypeScript 7
 * compiler, which has no JavaScript API). Skips comments and regular
 * expressions; returns plain string literals and interpolated templates.
 */
function literals(file: string) {
  const code = fs.readFileSync(file, 'utf8'); const plain: string[] = []; const templates: string[] = [];
  const unescape = (raw: string) => raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gs, (_, e: string) => e[0] === 'u' ? String.fromCodePoint(parseInt(e.replace(/[u{}]/g, ''), 16)) : e[0] === 'x' ? String.fromCharCode(parseInt(e.slice(1), 16)) : ({ n: '\n', r: '\r', t: '\t', '0': '\0' } as Record<string, string>)[e] ?? e);
  let i = 0; let last = '';
  const readQuoted = (quote: string) => { const begin = ++i; while (i < code.length && code[i] !== quote) { if (code[i] === '\\') i++; i++; } return code.slice(begin, i++); };
  function readTemplate(): void {
    const begin = i++; let interpolated = false; let text = '';
    while (i < code.length && code[i] !== '`') {
      if (code[i] === '\\') { text += code.slice(i, i + 2); i += 2; continue; }
      if (code[i] === '$' && code[i + 1] === '{') { interpolated = true; i += 2; scan('}'); i++; continue; }
      text += code[i++];
    }
    i++;
    if (!interpolated) { const value = unescape(text); if (cjk.test(value)) plain.push(value); }
    else if (cjk.test(code.slice(begin, i))) templates.push(code.slice(begin, Math.min(i, begin + 80)));
  }
  function scan(until?: string): void {
    let depth = 0;
    while (i < code.length) {
      const c = code[i];
      if (until && c === '}' && depth === 0) return;
      if (c === '{') depth++; else if (c === '}') depth--;
      if (c === '/' && code[i + 1] === '/') { i = code.indexOf('\n', i); if (i < 0) i = code.length; continue; }
      if (c === '/' && code[i + 1] === '*') { i = code.indexOf('*/', i + 2) + 2; if (i < 2) i = code.length; continue; }
      if (c === '"' || c === "'") { const value = unescape(readQuoted(c)); if (cjk.test(value)) plain.push(value); last = 'x'; continue; }
      if (c === '`') { readTemplate(); last = 'x'; continue; }
      if (c === '/' && (last === '' || /[(,=:[!&|?{};+\-*%<>~^]$/.test(last) || /\b(return|typeof|case|in|of|void)$/.test(last))) {
        i++; let inClass = false;
        while (i < code.length && (code[i] !== '/' || inClass)) { if (code[i] === '\\') i++; else if (code[i] === '[') inClass = true; else if (code[i] === ']') inClass = false; i++; }
        i++; while (/[a-z]/.test(code[i] ?? '')) i++; last = 'x'; continue;
      }
      if (!/\s/.test(c)) { if (/[A-Za-z0-9_$]/.test(c)) { const m = /^[A-Za-z0-9_$]+/.exec(code.slice(i))![0]; last = m; i += m.length; continue; } last = c; }
      i++;
    }
  }
  scan();
  return { plain, templates };
}

describe('backend message localization', () => {
  it('has English, Japanese and Korean text for every user-facing backend message', () => {
    const missing = userFacingFiles.flatMap(file => literals(file).plain.filter(text => !translations[text] && !(text in intentionallyUntranslated) && !modelFacingPrefixes.some(prefix => text.startsWith(prefix))).map(text => `${file}: ${text}`));
    expect(missing).toEqual([]);
  });
  it('keeps every translation complete and its placeholders intact', () => {
    for (const [source, targets] of Object.entries(translations)) {
      const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
      for (const target of targets) { expect(target.trim(), source).not.toBe(''); expect(names(target), source).toEqual(names(source)); }
    }
  });
  it('only contains reviewed interpolated Chinese templates', () => {
    const templates = userFacingFiles.flatMap(file => literals(file).templates.map(text => `${file}: ${text}`));
    expect(templates).toEqual(reviewedTemplates);
  });
});
