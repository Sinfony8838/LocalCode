# Refactor plan: plugin pipeline

Downstream teams want to hook the renderer (sanitizers, heading anchors,
custom blocks). Today the pipeline in `src/render.mjs` is hard-wired. Refactor
it to a plugin pipeline **without changing any rendered output** and without
breaking the public API.

## Required architecture

1. `createRenderer({ plugins = [], ...options })` returns a renderer object:
   - `render(markdown)` — runs the pipeline, returns the HTML string.
   - `use(plugin)` — registers a plugin for SUBSEQUENT renders. Returns the
     renderer (chainable).
2. `render(markdown)` stays exported from `src/index.mjs` and must behave
   exactly as today: equivalent to `createRenderer().render(markdown)`. All
   existing exports (`parseBlocks`, `renderInline`, `escapeHtml`) stay.
3. A plugin is `{ name, hooks }` where `hooks` may contain:
   - `beforeParse(markdown, ctx)` → replacement markdown or `undefined`
   - `afterParse(blocks, ctx)` → replacement block array or `undefined`
   - `renderBlock(block, ctx, next)` → HTML string for the block or
     `undefined`; `next()` invokes the rest of the chain and finally the
     built-in block renderer.
   - `afterRender(html, ctx)` → replacement HTML or `undefined`
4. Semantics:
   - Plugins run in registration order for every hook.
   - A hook returning `undefined` means "no change" (pass-through).
   - `renderBlock` chains: plugin A's hook may call `next()` to delegate to
     plugin B and finally to the built-in renderer; skipping `next()` replaces
     the built-in output for that block.
   - `ctx` is a fresh object per render call and must expose the renderer
     options as `ctx.options`.
5. Validation: `use()` and the `plugins` constructor option throw `TypeError`
   for anything that is not an object with a string `name`.

All existing tests must keep passing unmodified; rendered output for
plugin-free usage must be byte-identical to today.
