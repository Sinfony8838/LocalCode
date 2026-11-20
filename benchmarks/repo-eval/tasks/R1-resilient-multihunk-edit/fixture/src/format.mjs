// Display helpers shared by the CLI and the dashboard. Stable — do not change.

export function formatMs(ms) {
  return `${Math.round(ms)}ms`;
}

export function truncateLabel(label, max = 24) {
  const text = String(label);
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}
