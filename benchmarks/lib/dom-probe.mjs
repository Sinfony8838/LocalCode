// Shared in-process DOM probe for web-app benchmark tasks.
//
// Each task's verify.mjs composes a scenario (JS source) that drives the page
// through a small page API and returns an object of observable results. The
// probe runs in a child process (temp file) with the page HTML piped on stdin.
//
// Why not jsdom: the benchmark stays dependency-free and deterministic. The
// runtime below implements the subset real vanilla-JS apps rely on: a parsed
// DOM tree with text/element nodes, classList/dataset/attributes, event
// listeners with bubbling, forms (submit must be preventDefault()ed, matching
// what specs require), a fake clock driving timers and Date, and a
// localStorage that persists across reloads — the semantics feature specs
// depend on. Pages that need APIs outside this subset lose those points with
// a `stub error` detail, exactly like the T4 probe they replace.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from './common.mjs';

/** The child-side runtime. Written as a real function so it is typechecked syntax; stringified for the probe file. */
function runtimeFactory() {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const HTML_SOURCE = fs.readFileSync(0, 'utf8');

  // ---------------------------------------------------------------- parser
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const RAW = new Set(['script', 'style', 'textarea']);
  const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', deg: '°', middot: '·', bull: '•', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß' };

  function decodeEntities(s) {
    return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    });
  }
  function encodeText(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function parseFragment(src) {
    const root = { type: 'fragment', children: [] };
    const stack = [root];
    let i = 0;
    const top = () => stack[stack.length - 1];
    const pushText = raw => { if (raw) top().children.push({ type: 'text', text: decodeEntities(raw) }); };
    while (i < src.length) {
      if (src.startsWith('<!--', i)) { const end = src.indexOf('-->', i); i = end === -1 ? src.length : end + 3; continue; }
      if (src[i] === '<') {
        const close = /^<\/([a-zA-Z][\w-]*)\s*>/.exec(src.slice(i));
        if (close) {
          i += close[0].length;
          const name = close[1].toLowerCase();
          for (let s = stack.length - 1; s > 0; s--) if (stack[s].tagName === name) { stack.length = s; break; }
          continue;
        }
        const open = /^<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)(\/?)>/.exec(src.slice(i));
        if (open) {
          i += open[0].length;
          const el = { type: 'el', tagName: open[1].toLowerCase(), attrs: {}, children: [] };
          const attrText = open[2];
          let a = 0;
          const attrRe = /([^\s=/>]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]*)))?/g;
          let m;
          while ((m = attrRe.exec(attrText))) {
            if (!m[1]) continue;
            el.attrs[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
          }
          top().children.push(el);
          if (VOID.has(el.tagName) || open[3] === '/') continue;
          if (RAW.has(el.tagName)) {
            const rawEnd = new RegExp('</' + el.tagName + '\\s*>', 'i').exec(src.slice(i));
            const raw = rawEnd ? src.slice(i, i + rawEnd.index) : src.slice(i);
            el.children.push({ type: 'text', text: raw });
            i += rawEnd ? rawEnd.index + rawEnd[0].length : src.length - i;
            continue;
          }
          stack.push(el);
          continue;
        }
        if (src.startsWith('<!', i) || src.startsWith('<?', i)) { const end = src.indexOf('>', i); i = end === -1 ? src.length : end + 1; continue; }
      }
      const next = src.indexOf('<', i + 1);
      pushText(src.slice(i, next === -1 ? src.length : next));
      i = next === -1 ? src.length : next;
    }
    return root;
  }

  function serializeChildren(nodes) {
    return nodes.map(n => n.type === 'text' ? encodeText(n.text) : serializeEl(n)).join('');
  }
  function serializeAttrValue(v) { return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }
  function serializeEl(el) {
    const attrs = Object.entries(el.attrs).map(([k, v]) => v === '' ? ` ${k}` : ` ${k}="${serializeAttrValue(v)}"`).join('');
    // script/style/textarea content is raw text in HTML; everything else is escaped
    const inner = RAW.has(el._tagName)
      ? el.children.map(n => n.type === 'text' ? n.text : serializeEl(n)).join('')
      : serializeChildren(el.children);
    return `<${el._tagName}${attrs}>${inner}</${el._tagName}>`;
  }

  // ---------------------------------------------------------------- storage
  function makeStorage() {
    const map = new Map();
    return {
      getItem: k => (map.has(String(k)) ? map.get(String(k)) : null),
      setItem: (k, v) => map.set(String(k), String(v)),
      removeItem: k => map.delete(String(k)),
      clear: () => map.clear(),
      key: i => [...map.keys()][i] ?? null,
      get length() { return map.size; },
      __map: map,
    };
  }

  // ---------------------------------------------------------------- runtime
  function makeRuntime() {
    let now = 0;
    const timers = new Map();
    let nextId = 1;
    const localStorage = makeStorage();
    const sessionStorage = makeStorage();

    const schedule = (fn, ms, repeat) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + Math.max(0, ms || 0), every: repeat ? Math.max(1, ms || 0) : 0 });
      return id;
    };
    function advance(ms) {
      const end = now + ms;
      for (;;) {
        let due = null;
        for (const [id, t] of timers) if (t.at <= end && (!due || t.at < due[1].at)) due = [id, t];
        if (!due) break;
        const [id, t] = due;
        now = t.at;
        if (t.every) t.at += t.every; else timers.delete(id);
        try { t.fn(); } catch (error) { probeErrors.push(error); }
      }
      now = end;
    }

    const probeErrors = [];

    class ClassList {
      constructor(el) { this.el = el; }
      get set() { return new Set((this.el.attrs.class || '').split(/\s+/).filter(Boolean)); }
      _write(s) { const v = [...s].join(' '); if (v) this.el.attrs.class = v; else delete this.el.attrs.class; }
      add(...names) { const s = this.set; names.filter(Boolean).forEach(n => s.add(n)); this._write(s); }
      remove(...names) { const s = this.set; names.forEach(n => s.delete(n)); this._write(s); }
      toggle(name, force) {
        const s = this.set;
        const has = s.has(name);
        const want = force === undefined ? !has : !!force;
        if (want) s.add(name); else s.delete(name);
        this._write(s);
        return want;
      }
      contains(name) { return this.set.has(name); }
    }

    class Event {
      constructor(type, init = {}) {
        this.type = type;
        this.target = init.target ?? null;
        this.currentTarget = null;
        this.defaultPrevented = false;
        this.bubbles = init.bubbles ?? true;
        this.key = init.key; this.code = init.code; this.inputType = init.inputType;
      }
      preventDefault() { this.defaultPrevented = true; }
      stopPropagation() { this.stopped = true; }
      stopImmediatePropagation() { this.stopped = true; this.immediate = true; }
    }

    class Element {
      constructor(tagName) {
        this.type = 'el';
        this._tagName = String(tagName).toLowerCase();
        this.attrs = {};
        this.children = [];
        this.parentNode = null;
        this.listeners = new Map();
        this._value = '';
        this._valueTouched = false;
        this._checked = false;
        this.style = {};
        this.classList = new ClassList(this);
      }
      get id() { return this.attrs.id ?? ''; }
      set id(v) { this.attrs.id = String(v); }
      get tagName() { return this._tagName.toUpperCase(); }
      get className() { return this.attrs.class ?? ''; }
      set className(v) { if (v) this.attrs.class = String(v); else delete this.attrs.class; }
      get dataset() {
        const out = {};
        for (const [k, v] of Object.entries(this.attrs)) if (k.startsWith('data-')) out[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
        return out;
      }
      get isFormWidget() { return ['input', 'textarea', 'select'].includes(this._tagName); }
      get value() {
        if (this._tagName === 'select') {
          if (this._value !== '') return this._value;
          const options = this.querySelectorAll('option');
          const selected = options.find(o => o.attrs.selected !== undefined) ?? options[0];
          return selected ? (selected.attrs.value ?? selected.textContent.trim()) : '';
        }
        if (this._tagName === 'textarea') return this.children.map(c => c.text).join('');
        return this._valueTouched ? this._value : (this.attrs.value ?? '');
      }
      set value(v) {
        if (this._tagName === 'textarea') { this.children = [{ type: 'text', text: String(v) }]; return; }
        this._valueTouched = true;
        this._value = String(v);
      }
      get checked() { return this._tagName === 'input' ? (this.attrs.type === 'checkbox' || this.attrs.type === 'radio' ? this.attrs.checked !== undefined ? true : this._checked : false) : this._checked; }
      set checked(v) { this._checked = !!v; if (this.attrs.type === 'checkbox' || this.attrs.type === 'radio') { if (v) this.attrs.checked = ''; else delete this.attrs.checked; } }
      get disabled() { return this.attrs.disabled !== undefined; }
      set disabled(v) { if (v) this.attrs.disabled = ''; else delete this.attrs.disabled; }
      get hidden() { return this.attrs.hidden !== undefined; }
      set hidden(v) { if (v) this.attrs.hidden = ''; else delete this.attrs.hidden; }
      get textContent() {
        return this.children.map(c => c.type === 'text' ? c.text : c.textContent).join('');
      }
      set textContent(v) { this.children = [{ type: 'text', text: String(v) }]; }
      get innerText() { return this.textContent; }
      set innerText(v) { this.textContent = String(v); }
      get innerHTML() { return serializeChildren(this.children); }
      set innerHTML(v) { this.children = parseFragment(String(v)).children.map(hydrate); for (const c of this.children) c.parentNode = this; }
      get outerHTML() { return serializeEl(this); }
      get firstChild() { return this.children[0] ?? null; }
      get lastChild() { return this.children[this.children.length - 1] ?? null; }
      get nextSibling() { const s = this.parentNode?.children ?? []; return s[s.indexOf(this) + 1] ?? null; }
      get previousSibling() { const s = this.parentNode?.children ?? []; return s[s.indexOf(this) - 1] ?? null; }
      get parentElement() { return this.parentNode?.type === 'el' ? this.parentNode : null; }
      appendChild(node) {
        if (node.parentNode) node.parentNode.removeChild(node);
        node.parentNode = this;
        this.children.push(node);
        return node;
      }
      prepend(node) { if (node.parentNode) node.parentNode.removeChild(node); node.parentNode = this; this.children.unshift(node); return node; }
      insertBefore(node, ref) {
        if (node.parentNode) node.parentNode.removeChild(node);
        const i = ref ? this.children.indexOf(ref) : -1;
        node.parentNode = this;
        if (i === -1) this.children.push(node); else this.children.splice(i, 0, node);
        return node;
      }
      removeChild(node) {
        const i = this.children.indexOf(node);
        if (i !== -1) this.children.splice(i, 1);
        node.parentNode = null;
        return node;
      }
      remove() { if (this.parentNode) this.parentNode.removeChild(this); }
      replaceChild(node, old) { const i = this.children.indexOf(old); if (i === -1) return old; this.removeChild(old); this.insertBefore(node, this.children[i] ?? null); return old; }
      contains(node) { for (const c of this.children) if (c === node || (c.type === 'el' && c.contains(node))) return true; return false; }
      getAttribute(name) { return this.attrs[String(name).toLowerCase()] ?? null; }
      setAttribute(name, v) { this.attrs[String(name).toLowerCase()] = String(v); }
      removeAttribute(name) { delete this.attrs[String(name).toLowerCase()]; }
      hasAttribute(name) { return this.attrs[String(name).toLowerCase()] !== undefined; }
      getAttributeNames() { return Object.keys(this.attrs); }
      addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
      removeEventListener(type, fn) { const l = this.listeners.get(type) ?? []; const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1); }
      dispatchEvent(event) { fire(this, event); return !event.defaultPrevented; }
      click() { fire(this, new Event('click', { target: this })); }
      focus() { if (activeDocument) activeDocument.activeElement = this; }
      blur() { if (activeDocument && activeDocument.activeElement === this) activeDocument.activeElement = activeDocument.body; }
      closest(selector) { let el = this; while (el) { if (el.matches && el.matches(selector)) return el; el = el.parentElement; } return null; }
      matches(selector) { return matches(this, selector); }
      getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 100, height: 20 }; }
      querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
      querySelectorAll(sel) {
        const out = [];
        const walk = nodes => { for (const n of nodes) { if (n.type !== 'el') continue; out.push(n); walk(n.children); } };
        walk(this.children);
        return out.filter(el => matches(el, sel));
      }
      *descendants() { for (const c of this.children) { if (c.type === 'el') { yield c; yield* c.descendants(); } } }
    }

    function adopt(node, parent) { node.parentNode = parent; for (const c of node.children ?? []) if (c.type === 'el') adopt(c, node); }

    // parser output is plain objects; convert to live Elements (recursively)
    function hydrate(node) {
      if (node.type !== 'el') return node;
      const el = new Element(node.tagName);
      el.attrs = node.attrs;
      el.children = node.children.map(hydrate);
      for (const c of el.children) c.parentNode = el;
      return el;
    }

    // selector support: tag, #id, .class, [attr], [attr="v"], * and descendant/child combinators
    function matches(el, selector) {
      const parts = String(selector).trim().split(/\s*(>)\s*|\s+/).filter(Boolean);
      if (!parts.length) return false;
      let node = el;
      let index = parts.length - 1;
      if (!compound(node, parts[index])) return false;
      index -= 2;
      while (index >= 0) {
        const combinator = parts[index + 1];
        if (combinator === '>') { node = node.parentElement; if (!node || !compound(node, parts[index])) return false; }
        else { let up = node.parentElement; let ok = false; while (up) { if (compound(up, parts[index])) { ok = true; node = up; break; } up = up.parentElement; } if (!ok) return false; }
        index -= 2;
      }
      return true;
      function compound(n, c) {
        return c.split(/(?=[.#\[])/).every(token => {
          if (token === '*') return true;
          if (token.startsWith('#')) return n.attrs.id === token.slice(1);
          if (token.startsWith('.')) return (n.attrs.class || '').split(/\s+/).includes(token.slice(1));
          if (token.startsWith('[')) {
            const m = /^\[([^\s~^$*|=!]+)(?:([~^$*|]?)=?("([^"]*)"|'([^']*)'|([^\]]*)))?\]$/.exec(token);
            if (!m) return false;
            const name = m[1].toLowerCase();
            if (!m[2] && !m[3] && m[3] !== '') return n.attrs[name] !== undefined;
            const value = m[4] ?? m[5] ?? m[6] ?? '';
            const actual = n.attrs[name];
            if (actual === undefined) return false;
            if (!m[2]) return actual === value;
            if (m[2] === '~') return actual.split(/\s+/).includes(value);
            if (m[2] === '^') return actual.startsWith(value);
            if (m[2] === '$') return actual.endsWith(value);
            if (m[2] === '*') return actual.includes(value);
            if (m[2] === '|') return actual === value || actual.startsWith(value + '-');
            return true;
          }
          return n._tagName === token.toLowerCase();
        });
      }
    }

    function fire(target, event) {
      event.target = event.target ?? target;
      let node = target;
      while (node) {
        if (node.type === 'el' || node.type === 'document' || node.type === 'window') {
          event.currentTarget = node;
          const listeners = [...(node.listeners?.get(event.type) ?? [])];
          for (const fn of listeners) {
            try { fn.call(node, event); } catch (error) { probeErrors.push(error); }
            if (event.immediate) return;
          }
        }
        if (event.stopped) return;
        node = node.type === 'el' ? node.parentNode : null;
      }
      // window listeners receive bubbled document events
      if (activeWindow && event.bubbles && target.type === 'document') {
        event.currentTarget = activeWindow;
        for (const fn of [...(activeWindow.listeners.get(event.type) ?? [])]) { try { fn.call(activeWindow, event); } catch (error) { probeErrors.push(error); } }
      }
    }

    let activeDocument = null;
    let activeWindow = null;

    class DocumentNode extends Element {
      constructor() { super('#document'); this.type = 'document'; this.readyState = 'loading'; this.activeElement = null; this.title = ''; }
      getElementById(id) { return this.querySelectorAll(`#${CSS.id(id)}`)[0] ?? null; }
      createElement(tag) { return new Element(tag); }
      createTextNode(text) { return { type: 'text', text: String(text), parentNode: null }; }
      body = null;
      head = null;
      documentElement = null;
    }
    // CSS.escape is unavailable in the child; minimal id escaper for our own getElementById
    const CSS = { id: id => String(id).replace(/([^a-zA-Z0-9_-])/g, '\\$1') };

    const windows = [];

    function loadPage() {
      timers.clear(); // a reload discards the previous page's pending timers
      const doc = new DocumentNode();
      const parsed = parseFragment(HTML_SOURCE);
      doc.children = parsed.children.map(hydrate);
      for (const c of doc.children) c.parentNode = doc;
      doc.body = doc.children.find(c => c.type === 'el' && c._tagName === 'body') ?? doc;
      doc.head = doc.children.find(c => c.type === 'el' && c._tagName === 'head') ?? doc;
      doc.documentElement = doc.children.find(c => c.type === 'el' && c._tagName === 'html') ?? doc;
      doc.activeElement = doc.body;
      const titleEl = doc.head.children.find(c => c.type === 'el' && c._tagName === 'title');
      if (titleEl) doc.title = titleEl.textContent;

      const window = new Element('#window');
      window.type = 'window';
      window.document = doc;
      window.localStorage = localStorage;
      window.sessionStorage = sessionStorage;
      window.location = { href: 'http://probe.local/', origin: 'http://probe.local', reload() { didReload = true; }, toString() { return this.href; } };
      window.navigator = { userAgent: 'probe/1.0', language: 'zh-CN', clipboard: { writeText: async () => {} } };
      window.history = { pushState() {}, replaceState() {}, back() {} };
      window.matchMedia = () => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {} });
      window.getComputedStyle = () => new Proxy({}, { get: (t, p) => (p === 'getPropertyValue' ? () => '' : '') });
      window.alert = () => {};
      window.confirm = () => true;
      window.prompt = () => null;
      window.innerWidth = 1280; window.innerHeight = 800;
      window.requestAnimationFrame = fn => schedule(() => fn(now), 16, false);
      window.cancelAnimationFrame = id => timers.delete(id);
      window.setTimeout = (fn, ms) => schedule(fn, ms, false);
      window.setInterval = (fn, ms) => schedule(fn, ms, true);
      window.clearTimeout = id => timers.delete(id);
      window.clearInterval = id => timers.delete(id);
      window.console = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
      window.CustomEvent = class extends Event { constructor(type, init = {}) { super(type, init); this.detail = init.detail; } };
      window.Event = class extends Event { constructor(type, init = {}) { super(type, { bubbles: true, ...init }); } };
      window.InputEvent = window.Event;
      window.KeyboardEvent = class extends Event { constructor(type, init = {}) { super(type, { bubbles: true, ...init }); this.key = init.key; this.code = init.code; } };
      window.devicePixelRatio = 1;
      window.scrollTo = () => {};
      // the contextified window is the vm global; browsers expose these self-references
      window.window = window;
      window.self = window;
      window.parent = window;
      window.top = window;
      window.frames = window;

      class FakeDate extends Date {
        constructor(...a) { super(...(a.length ? a : [now])); }
        static now() { return now; }
      }
      window.Date = FakeDate;
      window.performance = { now: () => now };

      activeDocument = doc;
      activeWindow = window;
      const context = vm.createContext(window);
      windows.push(window);

      // run inline scripts in order
      for (const el of [...doc.querySelectorAll('script')]) {
        if (el.attrs.src !== undefined) { externalResources.push(el.attrs.src); continue; }
        const code = el.textContent;
        try { vm.runInContext(code, context, { timeout: 4000 }); } catch (error) { probeErrors.push(error); }
      }
      doc.readyState = 'complete';
      fire(doc, new Event('DOMContentLoaded', { target: doc }));
      fire(window, new Event('load', { target: window, bubbles: false }));

      return makePage(window, doc);
    }

    let didReload = false;
    const externalResources = [];

    function makePage(window, doc) {
      const findEl = target => {
        if (typeof target === 'string') { const el = doc.getElementById(target); if (!el) throw new Error(`missing element #${target}`); return el; }
        return target;
      };
      const page = {
        window, document: doc,
        el: id => { const el = doc.getElementById(id); if (!el) throw new Error(`missing element #${id}`); return el; },
        has: id => !!doc.getElementById(id),
        qs: sel => doc.querySelector(sel),
        qsa: sel => doc.querySelectorAll(sel),
        text: id => findEl(id).textContent.trim(),
        html: id => findEl(id).innerHTML,
        attr: (id, name) => findEl(id).getAttribute(name),
        count: sel => doc.querySelectorAll(sel).length,
        click: async target => {
          const el = findEl(target);
          if (el.disabled) return;
          if (el._tagName === 'input' && el.attrs.type === 'checkbox') {
            // browsers toggle the checkbox state before dispatching the click event
            el.checked = !el.checked;
            fire(el, new Event('click', { target: el }));
            fire(el, new Event('change', { target: el }));
            await flush();
            return;
          }
          fire(el, new Event('pointerdown', { target: el }));
          fire(el, new Event('mousedown', { target: el }));
          fire(el, new Event('click', { target: el }));
          await flush();
          if (el._tagName === 'button' && el.attrs.type !== 'button') {
            let form = el.closest('form');
            if (!form && el.attrs.type === 'submit') form = el.closest('form');
            if (form) {
              const submit = new Event('submit', { target: form });
              fire(form, submit);
              if (!submit.defaultPrevented) throw new Error('form submitted without preventDefault() — the page would reload (specs require handling this)');
            }
          }
        },
        setValue: async (target, value) => {
          const el = findEl(target);
          if (el._tagName === 'select') { el.value = value; fire(el, new Event('change', { target: el })); }
          else { el.value = value; fire(el, new Event('input', { target: el, inputType: 'insertText' })); }
          await flush();
        },
        type: async (target, text) => {
          const el = findEl(target);
          let current = el.value ?? '';
          for (const ch of String(text)) {
            current += ch;
            el.value = current;
            fire(el, new Event('input', { target: el, inputType: 'insertText' }));
          }
          await flush();
        },
        clear: async target => { const el = findEl(target); el.value = ''; fire(el, new Event('input', { target: el })); await flush(); },
        pressKey: async (key, target, init = {}) => {
          const el = target ? findEl(target) : doc.activeElement;
          fire(el, new Event('keydown', { target: el, key, code: init.code ?? key, ...init }));
          await flush();
        },
        dblclick: async target => {
          const el = findEl(target);
          if (el.disabled) return;
          fire(el, new Event('dblclick', { target: el }));
          await flush();
        },
        check: async (target, value = true) => {
          const el = findEl(target);
          el.checked = value;
          fire(el, new Event('change', { target: el }));
          fire(el, new Event('click', { target: el }));
          await flush();
        },
        submit: async target => {
          const form = findEl(target);
          const submit = new Event('submit', { target: form });
          fire(form, submit);
          if (!submit.defaultPrevented) throw new Error('form submitted without preventDefault() — the page would reload (specs require handling this)');
          await flush();
        },
        reload: () => { didReload = true; return loadPage(); },
        storage: localStorage,
        session: sessionStorage,
      };
      return page;
    }

    async function flush() { await Promise.resolve(); }

    return { loadPage, advance, get now() { return now; }, get errors() { return probeErrors; }, get external() { return externalResources; }, get reloaded() { return didReload; } };
  }

  const RT = makeRuntime();
  globalThis.RT = RT;
  globalThis.loadPage = RT.loadPage;
  globalThis.advance = RT.advance;
}
// Note: DOMContentLoaded/load fire before the scenario runs, matching pages that
// bind at parse time. Scenario code can load further pages via RT.loadPage().

function runtimeSource() {
  return '(' + runtimeFactory.toString() + ')();';
}
export { runtimeSource };

/**
 * Run a probe scenario against `html` in a child process and return its JSON result.
 * The scenario body is plain JS with globals: RT (runtime: loadPage/advance/now/errors),
 * plus the shorthands loadPage() and advance(ms).
 * Returns the scenario's result object, or { __error } when the child failed or threw.
 */
export async function runProbe(scenario, html, { timeout = 30_000 } = {}) {
  const source = `'use strict';\n${runtimeSource()}\n(async () => {\n${scenario}\n})()` +
    `.then(r => console.log('RESULT:' + JSON.stringify(r === undefined ? null : r)))` +
    `.catch(e => console.log('RESULT:' + JSON.stringify({ __error: String((e && e.message) || e), __errorStack: String((e && e.stack) || e).split(String.fromCharCode(10)).slice(0, 3).join(' | '), __appErrors: (globalThis.RT ? RT.errors : []).map(x => String((x && x.message) || x).slice(0, 300)) })));`;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-probe-'));
  try {
    const file = path.join(dir, 'probe.cjs');
    await fs.writeFile(file, source);
    const result = run(process.execPath, [file], { input: html ?? '', timeout });
    const line = [...result.stdout.matchAll(/RESULT:(.*)/g)].pop()?.[1];
    if (line) { try { return JSON.parse(line); } catch { /* fall through */ } }
    return { __error: result.error || result.stderr || 'probe produced no result' };
  } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

/** Check helper: every scenario-derived expectation fails cleanly when the probe errored. */
export function probeNote(result, extra = '') {
  const note = result?.__error ? `stub error: ${result.__error}` : extra;
  return note;
}
