import { workspaceContext } from '../src/core/workspace-context';
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ArtifactPreviews, MAX_PREVIEW_BYTES, resolveArtifactPath, externalBrowserUrl } from '../src/core/artifacts';

const base = path.resolve('tests');
const roots: string[] = [];
describe('external browser links', () => {
  it('accepts HTTP(S) only and canonicalizes Unicode and spaces', () => {
    expect(externalBrowserUrl('https://example.com/中文 页面#part')).toBe('https://example.com/%E4%B8%AD%E6%96%87%20%E9%A1%B5%E9%9D%A2#part');
    expect(externalBrowserUrl('http://localhost:1234/')).toBe('http://localhost:1234/');
    for (const input of ['javascript:alert(1)', 'file:///C:/Windows/notepad.exe', 'data:text/html,hello', 'ms-settings:privacy', 'localcode://app/index.html', '//example.com', 'https://exam\nple.com', '']) expect(() => externalBrowserUrl(input)).toThrow();
  });
});
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== base || !path.basename(root).startsWith('.artifacts-')) throw new Error('Unexpected test cleanup target');
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(base, '.artifacts-')); roots.push(root);
  const project = path.join(root, 'project'); const outside = path.join(root, 'outside');
  await fs.mkdir(project); await fs.mkdir(outside);
  await fs.mkdir(path.join(project, 'outputs', 'assets'), { recursive: true });
  await fs.writeFile(path.join(project, 'outputs', '页面 #1.html'), '<h1>preview</h1>');
  await fs.writeFile(path.join(project, 'outputs', 'assets', 'app.js'), "document.body.dataset.ready='yes';");
  await fs.writeFile(path.join(project, 'outputs', 'assets', 'style.css'), 'body{color:red}');
  await fs.writeFile(path.join(outside, 'escape.html'), 'PRIVATE');
  return { root, project, context: workspaceContext(project, path.join(root, 'data')), outside, previews: new ArtifactPreviews() };
}

describe('project artifact metadata', () => {
  it('accepts relative, absolute and local file URLs and retains encoded names', async () => {
    const f = await fixture(); const relative = 'outputs/页面 #1.html'; const absolute = path.join(f.project, relative);
    for (const input of [relative, absolute, pathToFileURL(absolute).href]) {
      const info = await f.previews.info(f.context, input, input.startsWith('file:') ? 'reference' : 'path');
      expect(info).toMatchObject({ path: relative, absolutePath: absolute, name: '页面 #1.html', kind: 'html', canOpenExternally: true });
      expect(info.previewUrl).toMatch(/^localcode-preview:\/\/[\da-f-]+\/outputs\/%/);
      const response = await f.previews.response({ url: info.previewUrl!, method: 'GET' });
      expect(response.status).toBe(200); expect(await response.text()).toBe('<h1>preview</h1>');
    }
  });
  it('resolves encoded Markdown paths and optional editor line references without weakening containment', async () => {
    const f = await fixture(); const relative = 'outputs/页面 #1.html'; const absolute = path.join(f.project, relative);
    const encoded = relative.split('/').map(encodeURIComponent).join('/');
    for (const input of [encoded, `${encoded}:12`, `${encoded}:12:3`, `${encoded}#L12`, `${encoded}#L12-L14`, `${pathToFileURL(absolute).href}#L12`, `${absolute}:12`]) {
      expect((await resolveArtifactPath(f.context, input, 'reference')).relative).toBe(relative);
    }
    for (const invalid of ['%2e%2e%2foutside%2fescape.html:1', '%2Egit/config#L1', 'javascript%3Aalert(1)', 'outputs/bad.html%3Astream', `${pathToFileURL(path.join(f.outside, 'escape.html')).href}#L1`]) {
      await expect(resolveArtifactPath(f.context, invalid, 'reference')).rejects.toThrow();
    }
  });
  it('keeps literal filesystem names separate from URI references even when both targets exist', async () => {
    const f = await fixture();
    const names = ['report%20final.txt', 'report final.txt', 'report%2520final.txt', 'notes.txt#L12', 'notes.txt', 'bad%FF.txt'];
    for (const name of names) await fs.writeFile(path.join(f.project, 'outputs', name), name);
    for (const name of names) {
      const relative = `outputs/${name}`;
      for (const input of [relative, path.join(f.project, relative)]) {
        const info = await f.previews.info(f.context, input);
        expect(info.path).toBe(relative);
        expect(await fs.readFile(info.absolutePath, 'utf8')).toBe(name);
        // Metadata is a raw path on refresh, source view and context-menu actions.
        expect((await f.previews.info(f.context, info.path)).path).toBe(relative);
      }
      for (const input of [relative.split('/').map(encodeURIComponent).join('/'), pathToFileURL(path.join(f.project, relative)).href]) {
        expect((await f.previews.info(f.context, input, 'reference')).path).toBe(relative);
      }
    }
    expect((await resolveArtifactPath(f.context, 'outputs/report%20final.txt', 'reference')).relative).toBe('outputs/report final.txt');
    expect((await resolveArtifactPath(f.context, 'outputs/report%2520final.txt', 'reference')).relative).toBe('outputs/report%20final.txt');
    expect((await resolveArtifactPath(f.context, 'outputs/notes.txt#L12', 'reference')).relative).toBe('outputs/notes.txt');
    await expect(resolveArtifactPath(f.context, 'outputs/bad%FF.txt', 'reference')).rejects.toThrow('URI');
    await expect(resolveArtifactPath(f.context, pathToFileURL(path.join(f.project, 'outputs/notes.txt')).href)).rejects.toThrow();
  });
  it('rejects remote URLs, traversal, outside absolute paths, ADS and protected git links', async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.project, '.git')); await fs.writeFile(path.join(f.project, '.git', 'config'), 'PRIVATE');
    await fs.symlink(f.outside, path.join(f.project, 'outside-alias'), 'junction');
    await fs.symlink(path.join(f.project, '.git'), path.join(f.project, 'git-alias'), 'junction');
    for (const input of ['https://example.com/index.html', 'javascript:alert(1)', '../outside/escape.html', path.join(f.outside, 'escape.html'), 'outputs/file.html:stream', 'outside-alias/escape.html', 'git-alias/config', '.git/config', 'file://server/share/index.html']) {
      await expect(resolveArtifactPath(f.context, input)).rejects.toThrow();
    }
  });
  it('does not default-launch executable scripts and keeps unsupported/oversize artifacts external', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.project, 'script.ps1'), 'echo no');
    await fs.writeFile(path.join(f.project, 'document.docx'), 'binary fixture');
    await fs.writeFile(path.join(f.project, 'sample.pdf'), '%PDF-1.4\n');
    const large = await fs.open(path.join(f.project, 'large.html'), 'w'); await large.truncate(MAX_PREVIEW_BYTES + 1); await large.close();
    expect(await f.previews.info(f.context, 'script.ps1')).toMatchObject({ kind: 'text', canOpenExternally: false });
    expect((await f.previews.info(f.context, 'document.docx')).previewUrl).toBeUndefined();
    expect(await f.previews.info(f.context, 'sample.pdf')).toMatchObject({ kind: 'pdf', canOpenExternally: true });
    expect((await f.previews.info(f.context, 'sample.pdf')).previewUrl).toBeUndefined();
    expect((await f.previews.info(f.context, 'large.html')).previewUrl).toBeUndefined();
  });
});

describe('isolated preview capability', () => {
  it('escapes literal percent and fragment names once in HTML preview and relative resources', async () => {
    const f = await fixture();
    const names = ['report%20final.html', 'report final.html', 'report%2520final.html', 'page#L12.html'];
    for (const name of names) await fs.writeFile(path.join(f.project, 'outputs', name), `<h1>${name}</h1>`);
    await fs.writeFile(path.join(f.project, 'outputs/assets/style%20final.css'), '/* literal percent */');
    await fs.writeFile(path.join(f.project, 'outputs/assets/style final.css'), '/* space */');
    for (const name of names) {
      const info = await f.previews.info(f.context, `outputs/${name}`);
      expect(new URL(info.previewUrl!).pathname).toBe(`/outputs/${encodeURIComponent(name)}`);
      expect(await (await f.previews.response({ url: info.previewUrl!, method: 'GET' })).text()).toBe(`<h1>${name}</h1>`);
      for (const [reference, content] of [['assets/style%2520final.css', '/* literal percent */'], ['assets/style%20final.css', '/* space */']]) {
        const response = await f.previews.response({ url: new URL(reference, info.previewUrl!).href, method: 'GET' });
        expect(response.status).toBe(200); expect(await response.text()).toBe(content);
      }
    }
  });
  it('serves relative scripts/css and sets sandbox, no-network, no-cache policy', async () => {
    const f = await fixture(); const info = await f.previews.info(f.context, 'outputs/页面 #1.html');
    for (const [resource, mime] of [['assets/app.js', 'text/javascript'], ['assets/style.css', 'text/css']]) {
      const response = await f.previews.response({ url: new URL(resource, info.previewUrl!).href, method: 'GET' });
      expect(response.status).toBe(200); expect(response.headers.get('Content-Type')).toContain(mime);
      expect(response.headers.get('Content-Security-Policy')).toContain('sandbox allow-scripts');
      expect(response.headers.get('Content-Security-Policy')).toContain("connect-src 'none'");
      expect(response.headers.get('Content-Security-Policy')).not.toContain('allow-same-origin');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
  });
  it('rejects unknown grants, changed methods, encoded traversal, metadata and links outside', async () => {
    const f = await fixture(); const info = await f.previews.info(f.context, 'outputs/页面 #1.html');
    // Node URL treats custom schemes as opaque origins; construct authority explicitly.
    const prefix = `localcode-preview://${new URL(info.previewUrl!).hostname}`;
    await fs.mkdir(path.join(f.project, '.private')); await fs.writeFile(path.join(f.project, '.private', 'secret.js'), 'PRIVATE');
    await fs.symlink(path.join(f.project, '.private'), path.join(f.project, 'hidden-alias'), 'junction');
    await fs.symlink(f.outside, path.join(f.project, 'escape-alias'), 'junction');
    const responses = await Promise.all([
      f.previews.response({ url: 'localcode-preview://ungranted/outputs/assets/app.js', method: 'GET' }),
      f.previews.response({ url: info.previewUrl!, method: 'POST' }),
      f.previews.response({ url: `${prefix}/%2e%2e%2foutside/escape.html`, method: 'GET' }),
      f.previews.response({ url: `${prefix}/.private/secret.js`, method: 'GET' }),
      f.previews.response({ url: `${prefix}/hidden-alias/secret.js`, method: 'GET' }),
      f.previews.response({ url: `${prefix}/escape-alias/escape.html`, method: 'GET' }),
    ]);
    expect(responses.every(r => r.status >= 400)).toBe(true);
    for (const response of responses) expect(await response.text()).not.toContain('PRIVATE');
  });
  it('revalidates deleted or replaced assets on every request', async () => {
    const f = await fixture(); const info = await f.previews.info(f.context, 'outputs/页面 #1.html');
    await fs.unlink(path.join(f.project, 'outputs', '页面 #1.html'));
    expect((await f.previews.response({ url: info.previewUrl!, method: 'GET' })).status).toBe(404);
  });
});
