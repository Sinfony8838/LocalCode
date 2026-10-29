import { escapeHtml } from './escape.mjs';

// Inline rules on ONE line of already-block-level text. HTML is escaped first,
// then emphasis/code/link markup is applied.
export function renderInline(text) {
  let out = escapeHtml(text);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, href) => {
    const safeHref = /^(https?:|mailto:|\/)/i.test(href) ? href : '#invalid-href';
    return `<a href="${safeHref}">${label}</a>`;
  });
  return out;
}
