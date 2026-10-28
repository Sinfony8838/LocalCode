import fs from 'node:fs/promises';
import path from 'node:path';
import { check, protectedCheck, run } from '../../lib/common.mjs';

// The behavioural probe runs the page's inline scripts in a child process with a
// deliberately small DOM stub and a fake clock. Pages that rely on DOM APIs the
// stub lacks fail these checks with an explanation; review those by hand.
const PROBE = String.raw`
const vm = require('node:vm'); const html = require('node:fs').readFileSync(0, 'utf8');
let now = 0; const timers = new Map(); let nextId = 1;
const schedule = (fn, ms, repeat) => { const id = nextId++; timers.set(id, { fn, at: now + Math.max(1, ms || 0), every: repeat ? Math.max(1, ms || 0) : 0 }); return id; };
const advance = ms => { const end = now + ms; for (;;) { let due = null; for (const [id, t] of timers) if (t.at <= end && (!due || t.at < due[1].at)) due = [id, t]; if (!due) break; const [id, t] = due; now = t.at; if (t.every) t.at += t.every; else timers.delete(id); t.fn(); } now = end; };
const listeners = new Map(); const on = (key, type, fn) => { const k = key + ':' + type; if (!listeners.has(k)) listeners.set(k, []); listeners.get(k).push(fn); };
const fire = (key, type, target) => { for (const fn of listeners.get(key + ':' + type) || []) fn.call(target, { type, target, currentTarget: target, preventDefault() {}, stopPropagation() {} }); };
const elements = {};
const idPattern = /<([a-zA-Z][\w-]*)\b([^>]*?)\bid\s*=\s*["']([^"']+)["']([^>]*)>([^<]*)/g;
for (const m of html.matchAll(idPattern)) {
  const id = m[3]; const el = { id, tagName: m[1].toUpperCase(), textContent: m[5].trim(), innerText: undefined, disabled: false, hidden: false, style: {}, dataset: {}, onclick: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, setAttribute(n, v) { if (n === 'disabled') this.disabled = true; }, removeAttribute(n) { if (n === 'disabled') this.disabled = false; }, getAttribute() { return null; },
    addEventListener(type, fn) { on('#' + id, type, fn); }, removeEventListener() {}, focus() {}, appendChild() {}, querySelector() { return null; } };
  Object.defineProperty(el, 'innerHTML', { get() { return this.textContent; }, set(v) { this.textContent = String(v).replace(/<[^>]*>/g, ''); } });
  Object.defineProperty(el, 'innerText', { get() { return this.textContent; }, set(v) { this.textContent = String(v); } });
  elements[id] = el;
}
const byId = id => elements[id] || null;
const document = { getElementById: byId, querySelector: sel => sel.startsWith('#') ? byId(sel.slice(1)) : null, querySelectorAll: () => [], addEventListener: (t, f) => on('document', t, f), removeEventListener() {},
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {}, addEventListener() {} }), body: { appendChild() {}, classList: { add() {}, remove() {} } }, documentElement: { style: {} }, readyState: 'loading', title: '' };
class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
const window = { document, addEventListener: (t, f) => on('window', t, f), removeEventListener() {}, setInterval: (f, ms) => schedule(f, ms, true), setTimeout: (f, ms) => schedule(f, ms, false),
  clearInterval: id => timers.delete(id), clearTimeout: id => timers.delete(id), requestAnimationFrame: f => schedule(() => f(now), 16, false), cancelAnimationFrame: id => timers.delete(id),
  Date: FakeDate, performance: { now: () => now }, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} }, Notification: undefined, Audio: function () { return { play() { return Promise.resolve(); } }; }, AudioContext: undefined, alert() {}, console: { log() {}, warn() {}, error() {} }, matchMedia: () => ({ matches: false, addEventListener() {} }) };
window.window = window; window.globalThis = window; window.self = window;
const context = vm.createContext(window);
const result = {};
try {
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) { if (/\bsrc\s*=/.test(m[1])) continue; vm.runInContext(m[2], context, { timeout: 2000 }); }
  document.readyState = 'complete'; fire('document', 'DOMContentLoaded', document); fire('window', 'load', window); advance(50);
  const text = id => (byId(id)?.textContent ?? '').trim();
  const click = id => { const el = byId(id); if (!el) throw new Error('missing #' + id); fire('#' + id, 'click', el); if (typeof el.onclick === 'function') el.onclick.call(el, { type: 'click', target: el, preventDefault() {} }); };
  result.initial = text('time');
  click('start'); advance(61000); result.after61 = text('time');
  click('start'); advance(10000); result.afterDoubleStart = text('time');
  click('pause'); advance(10000); result.afterPause = text('time');
  click('start'); advance(5000); result.afterResume = text('time');
  click('reset'); advance(3000); result.afterReset = text('time');
  click('start'); advance(25 * 60 * 1000 + 30000); result.finished = text('time'); result.status = text('status');
} catch (error) { result.error = String(error && error.message || error); }
console.log(JSON.stringify(result));
`;

export async function verify({ task, dir, baseline, current }) {
  const checks = [protectedCheck(task, baseline, current)];
  const html = await fs.readFile(path.join(dir, 'index.html'), 'utf8').catch(() => null);
  if (html === null) return { checks: [...checks, check('index.html exists', 90, false, 'index.html not found')] };
  const title = /<title>\s*([^<]*?)\s*<\/title>/i.exec(html)?.[1];
  checks.push(check('title is Pomodoro', 5, title === 'Pomodoro', `title: ${title}`));
  const external = [...html.matchAll(/\b(?:src|href)\s*=\s*["']\s*((?:https?:)?\/\/[^"']+)/gi), ...html.matchAll(/@import\s+url\(\s*["']?((?:https?:)?\/\/[^)"']+)/gi), ...html.matchAll(/\bfetch\s*\(\s*["'`](?:https?:)?\/\//gi)].map(m => m[1] ?? m[0]);
  checks.push(check('no external resources or requests', 5, external.length === 0, external.join(', ')));
  const ids = ['time', 'start', 'pause', 'reset', 'status'].filter(id => !new RegExp(`\\bid\\s*=\\s*["']${id}["']`).test(html));
  checks.push(check('required element ids present', 10, ids.length === 0, ids.length ? `missing: ${ids.join(', ')}` : ''));
  checks.push(check('viewport meta for small screens', 5, /<meta[^>]+name\s*=\s*["']viewport["']/i.test(html)));
  const probe = run(process.execPath, ['-e', PROBE], { input: html, timeout: 30_000 });
  let r = {}; try { r = JSON.parse(probe.stdout.trim().split(/\r?\n/).pop() || '{}'); } catch { r = { error: probe.stderr || probe.error || 'probe failed' }; }
  const note = r.error ? `stub DOM error: ${r.error}` : '';
  checks.push(check('starts at 25:00', 10, r.initial === '25:00', note || `shown: ${r.initial}`));
  checks.push(check('counts down once per second', 10, r.after61 === '23:59', note || `after 61 s: ${r.after61}`));
  checks.push(check('second start click does not speed up', 10, r.afterDoubleStart === '23:49', note || `shown: ${r.afterDoubleStart}`));
  checks.push(check('pause stops and start resumes', 10, r.afterPause === '23:49' && r.afterResume === '23:44', note || `paused: ${r.afterPause}, resumed: ${r.afterResume}`));
  checks.push(check('reset shows 25:00 and stops', 10, r.afterReset === '25:00', note || `shown: ${r.afterReset}`));
  checks.push(check('stops at 00:00 with Break time!', 15, r.finished === '00:00' && r.status === 'Break time!', note || `shown: ${r.finished}, status: ${r.status}`));
  return { checks };
}
