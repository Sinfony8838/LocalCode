import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { MAX_IMAGE_BYTES, decodePng, encodePng, normalizeAtlas, inspectAtlas } from './png-rgba.mjs';

const JSON_LIMIT = 24 * 1024 * 1024;
const optionsFor = {
  status: [], generate: ['prompt-file', 'out-dir', 'size', 'compat', 'timeout-seconds'],
  pack: ['input', 'out-dir', 'name', 'description'], validate: ['manifest'],
};
function parse(argv) {
  const [command, ...rest] = argv;
  if (!(command in optionsFor)) throw new Error('用法：pet-assets.mjs status | generate | pack | validate。详见随 Skill 提供的 api-guide。');
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) throw new Error('参数格式错误，请使用 --参数名 值。');
    const key = rest[i].slice(2);
    if (!optionsFor[command].includes(key) || key in options) throw new Error('出现不支持或重复的命令参数。');
    if (key === 'compat') options[key] = true;
    else {
      if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) throw new Error('命令参数缺少值。');
      options[key] = rest[++i];
    }
  }
  return { command, options };
}
function required(options, key) {
  const value = options[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少 --${key}。`);
  return value;
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
async function projectPath(value, existing = true) {
  const root = await fs.realpath(process.cwd()), candidate = path.resolve(root, value);
  if (!inside(root, candidate)) throw new Error('文件路径必须位于当前项目内。');
  if (existing) {
    const actual = await fs.realpath(candidate);
    if (!inside(root, actual)) throw new Error('符号链接不能指向当前项目之外。');
    return actual;
  }
  let ancestor = path.dirname(candidate);
  for (;;) {
    try { if (!inside(root, await fs.realpath(ancestor))) throw new Error('输出目录不能经过项目外的符号链接。'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; const next = path.dirname(ancestor); if (ancestor === next) throw error; ancestor = next; }
  }
  return candidate;
}
async function readLimited(value, limit) {
  const file = await projectPath(value), info = await fs.stat(file);
  if (!info.isFile() || info.size > limit) throw new Error('输入文件不存在、不是普通文件或超出大小限制。');
  const bytes = await fs.readFile(file);
  if (bytes.length > limit) throw new Error('读取中的文件超出大小限制。');
  return bytes;
}
async function newOutput(value) {
  const target = await projectPath(value, false);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const parent = await fs.realpath(path.dirname(target));
  if (!inside(await fs.realpath(process.cwd()), parent)) throw new Error('输出目录超出项目。');
  try { await fs.mkdir(target); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('输出目录已存在；请选择新目录以保留原有素材。'); throw error; }
  return target;
}
function outputPath(value) { return path.relative(process.cwd(), value).split(path.sep).join('/'); }
async function writeJson(file, value) { await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
function configuration(env = process.env) {
  return { baseUrl: env.LOCALCODE_IMAGE_BASE_URL?.trim(), model: env.LOCALCODE_IMAGE_MODEL?.trim(), apiKey: env.LOCALCODE_IMAGE_API_KEY?.trim() };
}
function localUrl(url) { return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname); }
function checkedUrl(value, allowLocal) {
  let url;
  try { url = new URL(value); } catch { throw new Error('图片接口或图片地址不是有效 URL。'); }
  if (url.username || url.password || url.hash) throw new Error('图片地址不能内嵌凭证或片段。');
  if (localUrl(url)) {
    if (!allowLocal || !['http:', 'https:'].includes(url.protocol)) throw new Error('远程图片服务不能返回本机图片地址。');
  } else {
    if (url.protocol !== 'https:') throw new Error('远程图片接口和下载地址必须使用 HTTPS。');
    if (/^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(url.hostname) || /^\[(?:fc|fd|fe80|::)/i.test(url.hostname)) throw new Error('图片地址不能指向私有或保留网络。');
  }
  return url;
}
async function limitedBody(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new Error('图片服务响应超出大小限制。'); }
  if (!response.body) throw new Error('图片服务返回空响应。');
  const reader = response.body.getReader(), parts = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length;
      if (length > maxBytes) { await reader.cancel(); throw new Error('图片服务响应超出大小限制。'); }
      parts.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(parts, length);
}
function httpFailure(status) {
  const reason = status === 401 || status === 403 ? '鉴权或图片模型权限不足' : status === 429 ? '限额或请求频率受限' : status >= 300 && status < 400 ? '接口重定向已拒绝' : '图片服务未成功返回图片';
  return new Error(`图片请求失败（HTTP ${status}）：${reason}。未自动重试。`);
}
export async function generate(options, env = process.env) {
  const config = configuration(env);
  if (!config.baseUrl || !config.model || !config.apiKey) throw new Error('请先配置 LOCALCODE_IMAGE_BASE_URL、LOCALCODE_IMAGE_MODEL、LOCALCODE_IMAGE_API_KEY；不要把密钥写入命令。');
  const base = checkedUrl(config.baseUrl, true);
  if (base.search || /\/(?:images\/generations|chat\/completions|responses|messages)\/?$/.test(base.pathname)) throw new Error('基础地址不要包含最终接口路径或查询参数。');
  base.pathname = base.pathname.replace(/\/+$/, '') + '/images/generations';
  const size = options.size ?? '1024x1536';
  if (!/^(?:auto|[1-9]\d{1,4}x[1-9]\d{1,4})$/.test(size)) throw new Error('size 应为供应商支持的 WIDTHxHEIGHT 或 auto。');
  const timeout = Number(options['timeout-seconds'] ?? 240);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 240) throw new Error('超时范围为 1–240 秒。');
  const prompt = (await readLimited(required(options, 'prompt-file'), 128_000)).toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!prompt || prompt.length > 32000) throw new Error('生图提示词需为 1–32000 个字符。');
  const out = await newOutput(required(options, 'out-dir'));
  const signal = AbortSignal.timeout(timeout * 1000);
  const body = { model: config.model, prompt, n: 1, size, ...(options.compat ? {} : { background: 'transparent', output_format: 'png' }) };
  try {
    const response = await fetch(base, { method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual', signal });
    if (!response.ok) { await response.body?.cancel(); throw httpFailure(response.status); }
    let payload;
    try { payload = JSON.parse((await limitedBody(response, JSON_LIMIT)).toString('utf8')); }
    catch (error) { if (error instanceof SyntaxError) throw new Error('图片服务没有返回有效 JSON。'); throw error; }
    const item = payload?.data?.[0]; let bytes;
    if (typeof item?.b64_json === 'string') {
      if (item.b64_json.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.b64_json) || item.b64_json.length % 4 !== 0) throw new Error('图片 base64 格式无效或超过 16 MiB。');
      bytes = Buffer.from(item.b64_json, 'base64');
    } else if (typeof item?.url === 'string') {
      const imageUrl = checkedUrl(item.url, localUrl(base));
      const imageResponse = await fetch(imageUrl, { redirect: 'manual', signal });
      if (!imageResponse.ok) { await imageResponse.body?.cancel(); throw httpFailure(imageResponse.status); }
      bytes = await limitedBody(imageResponse, MAX_IMAGE_BYTES);
    } else throw new Error('图片服务响应缺少 data[0].b64_json 或 data[0].url。');
    if (bytes.length > MAX_IMAGE_BYTES || bytes.length < 8 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('返回图片必须是小于 16 MiB 的 PNG。');
    await fs.writeFile(path.join(out, 'candidate.png'), bytes, { flag: 'wx' });
    let decoded;
    try { decoded = decodePng(bytes); }
    catch (error) { throw new Error(`${error.message} 原始候选已保留为 ${outputPath(path.join(out, 'candidate.png'))}，未生成可导入清单。`); }
    const result = { status: 'candidate', image: outputPath(path.join(out, 'candidate.png')), width: decoded.width, height: decoded.height, sha256: createHash('sha256').update(bytes).digest('hex'), visualReview: 'required', message: '已保存候选图，尚未证明网格和动作符合要求。下一步 pack 并查看预览。' };
    await writeJson(path.join(out, 'generation.json'), result);
    return result;
  } catch (error) {
    const message = signal.aborted ? '图片请求超时。服务器可能已处理请求；未自动重试。' : error.message === 'fetch failed' ? '无法连接图片服务；未自动重试。' : error.message;
    const safe = String(message).replaceAll(config.apiKey, '[密钥已隐藏]');
    await writeJson(path.join(out, 'generation-failure.json'), { status: 'failed', message: safe, retried: false }).catch(() => {});
    throw new Error(safe);
  }
}

function metadata(name, description = '') {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('宠物名字须为 1–80 个字符，不能包含控制字符。');
  if (typeof description !== 'string' || description.trim().length > 500 || /[\x00-\x1f\x7f]/.test(description)) throw new Error('宠物说明须为最多 500 个字符，不能包含控制字符。');
  return { name: name.trim(), description: description.trim(), atlas: 'pet.png' };
}
function escapeHtml(value) { return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function previewHtml(name, description) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(name)} · 桌宠预览</title>
<style>body{margin:0;padding:32px;background:#faf8f9;color:#29262a;font:15px/1.65 system-ui,"Microsoft YaHei UI",sans-serif}main{max-width:1100px;margin:auto}h1{margin:0;font-size:28px}p{color:#766b73}.controls{display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin:20px 0}button,select,input{font:inherit}button,select{background:white;border:1px solid #ddd2d9;border-radius:9px;padding:7px 12px}#grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}.card{background:#fff;border:1px solid #e6dfe3;border-radius:16px;padding:16px;text-align:center}.stage{display:flex;align-items:center;justify-content:center;min-height:220px;background-image:linear-gradient(45deg,#eee 25%,transparent 25%),linear-gradient(-45deg,#eee 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#eee 75%),linear-gradient(-45deg,transparent 75%,#eee 75%);background-size:16px 16px;background-position:0 0,0 8px,8px -8px,-8px 0;border-radius:10px}.sprite{width:192px;height:208px;background:url('./pet.png') no-repeat;background-size:1536px 2288px}strong{display:block;margin-top:8px}label{display:flex;gap:8px;align-items:center}#looks .sprite{margin:auto}#looks{margin:24px 0}a{color:#955477}</style>
<main><h1>${escapeHtml(name)}</h1><p>${escapeHtml(description)}</p><p>格式合格不代表动画合格。检查角色一致性、透明边缘、格子裁切、九种动作与十六个目光方向。</p><div class="controls"><button id="pause" type="button">暂停动画</button><label>预览底色<select id="back"><option value="grid">透明棋盘格</option><option value="#fff">白色</option><option value="#25212a">深色</option></select></label><a href="./pet.json">宠物清单</a><a href="./pet.png">完整图集</a></div><div id="grid"></div><section class="card" id="looks"><strong>目光方向（从正上方顺时针）</strong><div class="stage"><div class="sprite" id="look"></div></div><label>方向 <input id="direction" type="range" min="0" max="15" value="0"><span id="angle">0°</span></label></section></main>
<script>const rows=[['待机',6,4],['向右移动',8,8],['向左移动',8,8],['招手',4,5],['跳跃',5,6],['失败',8,4],['等待确认',6,3],['工作思考',6,4],['完成庆祝',6,4]];const grid=document.querySelector('#grid');for(const [i,row]of rows.entries()){const card=document.createElement('section');card.className='card';const stage=document.createElement('div');stage.className='stage';const sprite=document.createElement('div');sprite.className='sprite';sprite.dataset.row=i;sprite.style.backgroundPosition='0px '+(-208*i)+'px';stage.append(sprite);const label=document.createElement('strong');label.textContent=row[0];card.append(stage,label);grid.append(card)}let paused=matchMedia('(prefers-reduced-motion: reduce)').matches;const pause=document.querySelector('#pause');function updatePause(){pause.textContent=paused?'继续动画':'暂停动画';pause.setAttribute('aria-pressed',String(paused))}updatePause();pause.onclick=()=>{paused=!paused;updatePause()};let t=0;setInterval(()=>{if(paused)return;t+=50;document.querySelectorAll('[data-row]').forEach(sprite=>{const r=Number(sprite.dataset.row),f=Math.floor(t*rows[r][2]/1000)%rows[r][1];sprite.style.backgroundPosition=(-192*f)+'px '+(-208*r)+'px'})},50);document.querySelector('#back').onchange=e=>document.querySelectorAll('.stage').forEach(s=>{s.style.backgroundImage=e.target.value==='grid'?'':'none';s.style.backgroundColor=e.target.value==='grid'?'':e.target.value});const d=document.querySelector('#direction');function look(){const n=Number(d.value);document.querySelector('#look').style.backgroundPosition=(-192*(n%8))+'px '+(-208*(n<8?9:10))+'px';document.querySelector('#angle').textContent=(n*22.5)+'°'}d.oninput=look;look();</script></html>`;
}
export async function pack(options) {
  const manifest = metadata(required(options, 'name'), options.description ?? '');
  const original = decodePng(await readLimited(required(options, 'input'), MAX_IMAGE_BYTES));
  const normalized = normalizeAtlas(original), report = inspectAtlas(normalized), bytes = encodePng(normalized);
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('规范化后的图集超过 16 MiB，请减小素材复杂度。');
  const out = await newOutput(required(options, 'out-dir'));
  await fs.writeFile(path.join(out, 'pet.png'), bytes, { flag: 'wx' });
  await writeJson(path.join(out, 'pet.json'), manifest);
  await writeJson(path.join(out, 'validation.json'), { ...report, normalized: original.width !== 1536 || original.height !== 2288, originalSize: { width: original.width, height: original.height } });
  await fs.writeFile(path.join(out, 'preview.html'), previewHtml(manifest.name, manifest.description), { flag: 'wx' });
  return { status: 'format-valid', manifest: outputPath(path.join(out, 'pet.json')), preview: outputPath(path.join(out, 'preview.html')), visualReview: 'required', warnings: report.warnings };
}
export async function validate(options) {
  const manifestFile = await projectPath(required(options, 'manifest'));
  let manifest;
  try { manifest = JSON.parse((await readLimited(manifestFile, 16_384)).toString('utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error instanceof SyntaxError) throw new Error('pet.json 不是有效 JSON。'); throw error; }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || Object.keys(manifest).some(key => !['name', 'description', 'atlas'].includes(key))) throw new Error('清单仅允许 name、description、atlas 字段。');
  metadata(manifest.name, manifest.description);
  if (typeof manifest.atlas !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.png$/i.test(manifest.atlas)) throw new Error('atlas 必须为同目录 PNG 文件名，不能含目录或 URL。');
  return inspectAtlas(decodePng(await readLimited(path.join(path.dirname(manifestFile), manifest.atlas), MAX_IMAGE_BYTES)));
}
export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parse(argv);
  if (command === 'status') {
    const config = configuration();
    return { baseUrlConfigured: !!config.baseUrl, modelConfigured: !!config.model, apiKeyConfigured: !!config.apiKey, runtime: 'Node.js', ready: !!(config.baseUrl && config.model && config.apiKey) };
  }
  if (command === 'generate') return generate(options);
  if (command === 'pack') return pack(options);
  return validate(options);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    const key = configuration().apiKey;
    const message = key ? String(error.message).replaceAll(key, '[密钥已隐藏]') : String(error.message);
    console.error(JSON.stringify({ status: 'failed', message })); process.exitCode = 1;
  });
}
