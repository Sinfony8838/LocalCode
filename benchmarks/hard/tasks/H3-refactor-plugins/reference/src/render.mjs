import { parseBlocks } from './parse-blocks.mjs';
import { renderInline } from './parse-inline.mjs';
import { escapeHtml } from './escape.mjs';

// The pipeline: beforeParse → parseBlocks → (per-block renderBlock chain) →
// afterRender. Plugins run in registration order; a hook returning undefined
// means "no change". The built-in block renderer is the terminal of the
// renderBlock chain.

function blockToHtml(block) {
  switch (block.type) {
    case 'heading':
      return `<h${block.level}>${renderInline(block.text)}</h${block.level}>`;
    case 'paragraph':
      return `<p>${renderInline(block.text)}</p>`;
    case 'list':
      return `<ul>${block.items.map(item => `<li>${renderInline(item)}</li>`).join('')}</ul>`;
    case 'code':
      return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
    case 'quote':
      return `<blockquote><p>${renderInline(block.text)}</p></blockquote>`;
    default:
      throw new Error(`unknown block type: ${block.type}`);
  }
}

function assertValidPlugin(plugin) {
  if (plugin === null || typeof plugin !== 'object' || Array.isArray(plugin) || typeof plugin.name !== 'string') {
    throw new TypeError('a plugin must be an object with a string name');
  }
}

function composeRenderBlock(plugins, builtin) {
  return (block, ctx) => {
    const run = position => {
      if (position >= plugins.length) return builtin(block, ctx);
      const hook = plugins[position].hooks?.renderBlock;
      if (typeof hook !== 'function') return run(position + 1);
      const produced = hook(block, ctx, () => run(position + 1));
      return produced === undefined ? run(position + 1) : produced;
    };
    return run(0);
  };
}

export function createRenderer({ plugins = [], ...options } = {}) {
  const registered = [];
  for (const plugin of plugins) {
    assertValidPlugin(plugin);
    registered.push(plugin);
  }

  const renderer = {
    get plugins() { return [...registered]; },
    use(plugin) {
      assertValidPlugin(plugin);
      registered.push(plugin);
      return renderer;
    },
    render(markdown) {
      const ctx = { options };
      let text = String(markdown ?? '');
      for (const plugin of registered) {
        const hook = plugin.hooks?.beforeParse;
        if (typeof hook === 'function') {
          const produced = hook(text, ctx);
          if (produced !== undefined) text = produced;
        }
      }
      let blocks = parseBlocks(text);
      for (const plugin of registered) {
        const hook = plugin.hooks?.afterParse;
        if (typeof hook === 'function') {
          const produced = hook(blocks, ctx);
          if (produced !== undefined) blocks = produced;
        }
      }
      const renderBlock = composeRenderBlock(registered, blockToHtml);
      let html = blocks.map(block => renderBlock(block, ctx)).join('');
      for (const plugin of registered) {
        const hook = plugin.hooks?.afterRender;
        if (typeof hook === 'function') {
          const produced = hook(html, ctx);
          if (produced !== undefined) html = produced;
        }
      }
      return html;
    },
  };
  return renderer;
}

export function render(markdown) {
  return createRenderer().render(markdown);
}
