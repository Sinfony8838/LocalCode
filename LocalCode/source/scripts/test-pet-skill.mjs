import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { generate, pack, validate } from '../skills/create-desktop-pet/scripts/pet-assets.mjs';
import { decodePng, encodePng, inspectAtlas, normalizeAtlas, FRAME_COUNTS } from '../skills/create-desktop-pet/scripts/png-rgba.mjs';
import { syntheticPetAtlas } from './helpers/pet-fixture.mjs';

const source = process.cwd(), root = path.resolve('../evidence', `pet-skill-${Date.now()}`);
const cli = path.join(source, 'skills/create-desktop-pet/scripts/pet-assets.mjs');
let server, base, count = 0, png, tiny, mode = 'base64';
const secret = 'fixture-secret-never-log';
const captures = [];
function fixture() {
  const width = 80, height = 110, rgba = Buffer.alloc(width * height * 4);
  for (let row = 0; row < 11; row++) for (let col = 0; col < FRAME_COUNTS[row]; col++) {
    for (let y = 2; y < 8; y++) for (let x = 3; x < 7; x++) {
      const i = ((row * 10 + y) * width + col * 10 + x) * 4;
      rgba[i] = row * 20; rgba[i + 1] = col * 30; rgba[i + 2] = 123; rgba[i + 3] = 255;
    }
  }
  return { width, height, rgba };
}
function config() { return { LOCALCODE_IMAGE_BASE_URL: base, LOCALCODE_IMAGE_MODEL: 'fixture-image', LOCALCODE_IMAGE_API_KEY: secret }; }
function opts(name) { return { 'prompt-file': 'prompt.txt', 'out-dir': name }; }
async function run(args, overrides = {}) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, LOCALCODE_IMAGE_BASE_URL: '', LOCALCODE_IMAGE_MODEL: '', LOCALCODE_IMAGE_API_KEY: '', ...overrides }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
  const [code] = await once(child, 'exit'); return { code, stdout, stderr };
}
before(async () => {
  await fs.mkdir(root, { recursive: true }); process.chdir(root);
  await fs.writeFile('prompt.txt', '透明背景，8列11行测试图集。');
  tiny = encodePng(fixture()); png = encodePng(normalizeAtlas(fixture())); await fs.writeFile('fixture.png', tiny);
  server = http.createServer(async (req, res) => {
    if (req.url === '/image.png') { captures.push({ imageAuthorization: req.headers.authorization }); res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    count++; captures.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) });
    if (mode === 'auth') { res.writeHead(401); res.end(JSON.stringify({ error: { message: secret } })); return; }
    if (mode === 'oversize') { res.writeHead(200, { 'Content-Length': String(25 * 1024 * 1024) }); res.end(); return; }
    if (mode === 'timeout') return;
    if (mode === 'redirect') { res.writeHead(302, { Location: base + '/images/generations' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (mode === 'url') res.end(JSON.stringify({ data: [{ url: base.replace('/v1', '') + '/image.png' }] }));
    else if (mode === 'corrupt') res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('not a png').toString('base64') }] }));
    else if (mode === 'crc') { const bad = Buffer.from(png); bad[44] ^= 1; res.end(JSON.stringify({ data: [{ b64_json: bad.toString('base64') }] })); }
    else res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}/v1`;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); process.chdir(source); console.log(`Evidence: ${root}`); });

test('PNG decoder round-trips RGBA; canonical atlas has 73 required frames', () => {
  const decoded = decodePng(tiny); assert.deepEqual(decoded, fixture());
  const report = inspectAtlas(decodePng(png)); assert.equal(report.requiredFrames, 73); assert.equal(report.visualReview, 'required');
});
test('decoder accepts an independently encoded synthetic atlas and preserves pixels', () => {
  const bytes = syntheticPetAtlas();
  const decoded = decodePng(bytes), again = decodePng(encodePng(decoded)); assert.deepEqual(again.rgba, decoded.rgba);
  assert.equal(decoded.width, 1536); assert.equal(decoded.height, 2288);
});
test('CRC corruption, truncation, missing frames and opaque backgrounds are rejected', () => {
  const corrupt = Buffer.from(tiny); corrupt[44] ^= 1; assert.throws(() => decodePng(corrupt), /校验和/);
  assert.throws(() => decodePng(tiny.subarray(0, tiny.length - 4)), /截断|长度|完整/);
  const empty = { width: 1536, height: 2288, rgba: Buffer.alloc(1536 * 2288 * 4) }; assert.throws(() => inspectAtlas(empty), /空的必需帧/);
  empty.rgba.fill(255); assert.throws(() => inspectAtlas(empty), /透明背景/);
});
test('pack normalizes, preserves original, creates manifest and escaped offline preview; validate succeeds', async () => {
  const before = createHash('sha256').update(await fs.readFile('fixture.png')).digest('hex');
  const result = await pack({ input: 'fixture.png', 'out-dir': 'packed', name: '<猫 & 狗>', description: '围巾' });
  assert.equal(result.status, 'format-valid');
  const manifest = JSON.parse(await fs.readFile('packed/pet.json', 'utf8')); assert.deepEqual(manifest, { name: '<猫 & 狗>', description: '围巾', atlas: 'pet.png' });
  const html = await fs.readFile('packed/preview.html', 'utf8'); assert(html.includes('&lt;猫 &amp; 狗&gt;')); assert(!html.includes('<猫 & 狗>'));
  assert.equal((await validate({ manifest: 'packed/pet.json' })).requiredFrames, 73);
  assert.equal(createHash('sha256').update(await fs.readFile('fixture.png')).digest('hex'), before);
  await assert.rejects(pack({ input: 'fixture.png', 'out-dir': 'packed', name: '猫' }), /已存在/);
});
test('manifest traversal, project escape and symlink escape are rejected', async () => {
  await fs.writeFile('bad-manifest.json', JSON.stringify({ name: '猫', atlas: '../outside.png' }));
  await assert.rejects(validate({ manifest: 'bad-manifest.json' }), /同目录/);
  await assert.rejects(pack({ input: '../fixture.png', 'out-dir': 'escape', name: '猫' }), /项目内/);
  await fs.symlink(source, path.join(root, 'outside-link'), 'junction');
  await assert.rejects(pack({ input: 'outside-link/package.json', 'out-dir': 'escape', name: '猫' }), /符号链接/);
});
test('API base64 generation uses the explicit model, requests transparency, and does not claim import readiness', async () => {
  mode = 'base64'; const result = await generate(opts('base64'), config());
  assert.equal(result.status, 'candidate'); assert.equal(result.visualReview, 'required');
  const request = captures.at(-1); assert.equal(request.path, '/v1/images/generations'); assert.equal(request.body.model, 'fixture-image'); assert.equal(request.body.background, 'transparent'); assert.equal(request.body.output_format, 'png'); assert.equal(request.authorization, `Bearer ${secret}`);
  await assert.rejects(fs.stat('base64/pet.json'), { code: 'ENOENT' });
  assert(!(await fs.readFile('base64/generation.json', 'utf8')).includes(secret));
});
test('URL generation downloads without forwarding the API key', async () => {
  mode = 'url'; const result = await generate(opts('url'), config()); assert.equal(result.status, 'candidate');
  assert.equal(captures.at(-1).imageAuthorization, undefined);
});
test('authentication failure is bounded, redacts provider body, and never retries', async () => {
  mode = 'auth'; const before = count;
  await assert.rejects(generate(opts('auth'), config()), error => /401/.test(error.message) && !error.message.includes(secret));
  assert.equal(count, before + 1); assert(!(await fs.readFile('auth/generation-failure.json', 'utf8')).includes(secret));
});
test('response size, redirects, invalid images and timeout fail without retries', async () => {
  for (const [value, pattern] of [['oversize', /大小限制/], ['redirect', /重定向/], ['corrupt', /PNG/], ['timeout', /超时/]]) {
    mode = value; const before = count;
    await assert.rejects(generate({ ...opts(value), 'timeout-seconds': '1' }, config()), pattern); assert.equal(count, before + 1);
  }
});
test('a PNG candidate failing decode is preserved for diagnosis without a ready manifest', async () => {
  mode = 'crc'; await assert.rejects(generate(opts('crc'), config()), /原始候选已保留/);
  assert((await fs.stat('crc/candidate.png')).size > 0); await assert.rejects(fs.stat('crc/pet.json'), { code: 'ENOENT' });
});
test('CLI status never prints values; unconfigured generation makes no network request or output directory', async () => {
  const status = await run(['status'], config()); assert.equal(status.code, 0); assert.equal(JSON.parse(status.stdout).ready, true); assert(!status.stdout.includes(secret)); assert(!status.stdout.includes(base));
  const before = count, result = await run(['generate', '--prompt-file', 'prompt.txt', '--out-dir', 'missing-config']);
  assert.equal(result.code, 1); assert(result.stderr.includes('先配置')); assert.equal(count, before); await assert.rejects(fs.stat('missing-config'), { code: 'ENOENT' });
});
