# marklet

A small markdown → HTML renderer. Zero dependencies.

```js
import { render } from './src/index.mjs';

render('# Hello\n\nWorld **bold**');
// → '<h1>Hello</h1><p>World <strong>bold</strong></p>'
```

## Rendered rules

1. All HTML is escaped before any rule applies (`src/escape.mjs`).
2. Blocks (`src/parse-blocks.mjs`): `# ` → `h1`/`h2`/`h3` (up to `### `),
   `- ` runs → one `<ul>`, fenced ` ``` ` → `<pre><code>`, `> ` →
   `<blockquote><p>`, every other non-empty line → its own `<p>`, blank lines
   produce nothing.
3. Inline (`src/parse-inline.mjs`, applied within every block except code):
   `**x**` → `<strong>`, `*x*` → `<em>`, `` `x` `` → `<code>`,
   `[label](href)` → `<a>` (href must start with `https:`, `mailto:` or `/`,
   otherwise it becomes `#invalid-href`).

## Public API

`render(markdown)` — the only supported entry point today.
`parseBlocks`, `renderInline` and `escapeHtml` are internal modules with
stable contracts; the existing unit tests cover them directly.
