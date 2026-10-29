# Markdown note editor

Create a single self-contained `index.html` in this folder (inline CSS and JavaScript; no external resources and no third-party Markdown libraries — implement rendering yourself).

Required elements, all present in the initial HTML:

- `<textarea id="editor">` — Markdown source.
- `<div id="preview">` — rendered HTML, updated live on every `input` of the editor (no save button press needed for preview).
- `<span id="word-count">` — the number of whitespace-separated non-empty words in the editor, formatted exactly as `N words` (always plural: `0 words`, `1 words`, `2 words`).
- `<button id="save-note">` — saves the editor content to `localStorage` under the key `note`.
- `<button id="btn-clear">` — empties the editor (preview and word count update; a previously saved note is unaffected until saved again).

Markdown rendering rules (in `#preview`, applied in this order):

1. Escape all HTML first: source like `<b>x</b>` renders as literal text `<b>x</b>` and must not create `b`, `img` or `script` elements.
2. A line starting with `# `, `## ` or `### ` renders as `<h1>`, `<h2>` or `<h3>` with the rest of the line as content.
3. A line starting with `- ` is a list item; consecutive `- ` lines form ONE `<ul>` with one `<li>` per line.
4. A line matching `<digits>. ` (e.g. `1. `, `10. `) is a list item; consecutive such lines form ONE `<ol>`.
5. Any other non-empty line renders as its own `<p>`; blank lines render nothing.
6. Inline styles inside any block content: `**text**` → `<strong>text</strong>`, `*text*` → `<em>text</em>`, `` `text` `` → `<code>text</code>`.
7. Blocks appear in source order. Example: the source

```
# Plan

- a
- b

The **end**.
```

renders exactly the children `h1`, `ul` (two `li`), `p` — in that order.

On load, if a saved note exists (key `note`), restore it into the editor and render it.
