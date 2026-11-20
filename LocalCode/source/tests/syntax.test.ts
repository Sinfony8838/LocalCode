import { describe, expect, it } from 'vitest';
import { isJsSyntaxTarget, jsonSyntaxDiagnostic, postEditSyntaxDiagnostic } from '../src/core/syntax.js';

describe('post-edit syntax diagnostics', () => {
  it('accepts valid JSON and reports the parser message for broken JSON', async () => {
    expect(jsonSyntaxDiagnostic('{"a": 1}')).toBeNull();
    const diagnostic = jsonSyntaxDiagnostic('{"a": 1,}');
    expect(diagnostic?.language).toBe('json');
    expect(diagnostic?.message.length).toBeGreaterThan(0);
    await expect(postEditSyntaxDiagnostic('data.json', '{"a": 1,}')).resolves.toContain('JSON 格式无效');
  });

  it('flags broken JavaScript with the parser error line and clears valid scripts', async () => {
    const diagnostic = await postEditSyntaxDiagnostic('solve.mjs', 'const x = ;\n');
    expect(diagnostic).toContain('语法检查警告');
    expect(diagnostic).toContain('JavaScript');
    expect(await postEditSyntaxDiagnostic('solve.mjs', 'const x = 1;\n')).toBe('');
  });

  it('validates cjs and js extensions and skips non-JS targets', async () => {
    expect(isJsSyntaxTarget('app.js')).toBe(true);
    expect(isJsSyntaxTarget('run.mjs')).toBe(true);
    expect(isJsSyntaxTarget('legacy.cjs')).toBe(true);
    expect(isJsSyntaxTarget('model.ts')).toBe(false);
    expect(isJsSyntaxTarget('notes.md')).toBe(false);
    expect(await postEditSyntaxDiagnostic('model.ts', 'const x = ;')).toBe('');
    expect(await postEditSyntaxDiagnostic('page.html', '<p>hi</p>')).toBe('');
  });

  it('resolves ESM correctly by extension (.mjs import syntax ok, .cjs rejected)', async () => {
    expect(await postEditSyntaxDiagnostic('run.mjs', 'import fs from "node:fs";\n')).toBe('');
    const diagnostic = await postEditSyntaxDiagnostic('legacy.cjs', 'import fs from "node:fs";\n');
    expect(diagnostic).toContain('语法检查警告');
  });
});
