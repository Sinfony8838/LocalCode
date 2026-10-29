import { parseBlocks } from './parse-blocks.mjs';
import { renderInline } from './parse-inline.mjs';
import { escapeHtml } from './escape.mjs';

// The whole pipeline is hard-wired: parse blocks, render each block type,
// join. There is no way to extend or hook into this today.
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

export function render(markdown) {
  return parseBlocks(markdown).map(blockToHtml).join('');
}
