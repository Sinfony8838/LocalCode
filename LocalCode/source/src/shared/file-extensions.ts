/**
 * Extensions that make a bare inline-code mention (no directory part) look like
 * a file worth linking. Anything else — `localStorage.todos`, `.edit`,
 * `display:none` — is prose, not a path, and must not become a clickable file
 * link. Paths that contain a separator (`outputs/app.js`, `./report.md`) are
 * unaffected: shape alone proves intent.
 */
export const KNOWN_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'log', 'xml', 'yaml', 'yml', 'toml', 'ini', 'env',
  'html', 'htm', 'css', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'sql', 'sh', 'ps1', 'bat', 'cmd', 'tex', 'vue', 'svelte',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif',
  'woff', 'woff2', 'ttf', 'otf',
  'pdf', 'mp3', 'wav', 'ogg', 'mp4', 'webm',
  'zip', 'gz', 'rar', '7z', 'xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt',
]);
