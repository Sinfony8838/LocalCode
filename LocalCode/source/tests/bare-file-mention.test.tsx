import { describe, expect, it } from 'vitest';
import { isBareFileMention } from '../src/renderer/Artifacts';

describe('bare inline-code mention gate', () => {
  it('links shapes that prove path intent or carry a known extension', () => {
    for (const value of ['index.html', 'SPEC.md', 'package.json', 'outputs/app.js', './report.md', '.github/workflows.yml', 'D:\\x\\y.md', 'file:///C:/x.md'])
      expect(isBareFileMention(value)).toBe(true);
  });
  it('does not link prose tokens that merely contain a dot', () => {
    for (const value of ['localStorage.todos', '.edit', 'selected', 'display: none', 'img.onerror', 'v1.2', 'todoList.replaceChildren', 'XMLHttpRequest'])
      expect(isBareFileMention(value)).toBe(false);
  });
});
