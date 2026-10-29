// Splits markdown into a block AST:
//   { type: 'heading', level, text } | { type: 'paragraph', text }
//   { type: 'list', items: string[] } | { type: 'code', text }
//   { type: 'quote', text }
// Blank lines produce nothing; every other non-empty line belongs to a block.
export function parseBlocks(markdown) {
  const blocks = [];
  const lines = String(markdown).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (line.startsWith('```')) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) { code.push(lines[i]); i++; }
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    let m;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
      blocks.push({ type: 'heading', level: m[1].length, text: m[2] });
      continue;
    }
    if (/^-\s+/.test(line)) {
      const items = [];
      let j = i;
      while (j < lines.length && /^-\s+/.test(lines[j])) {
        items.push(lines[j].replace(/^-\s+/, ''));
        j++;
      }
      i = j - 1;
      blocks.push({ type: 'list', items });
      continue;
    }
    if (/^>\s?/.test(line)) {
      blocks.push({ type: 'quote', text: line.replace(/^>\s?/, '') });
      continue;
    }
    blocks.push({ type: 'paragraph', text: line });
  }
  return blocks;
}
