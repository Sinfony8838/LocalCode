// CSV parse/serialize. See README.md for the exact specification.

function delimiterOf(options) {
  const delimiter = options.delimiter ?? ',';
  if (typeof delimiter !== 'string' || delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') {
    throw new RangeError('delimiter must be a single character other than a quote or a line break');
  }
  return delimiter;
}

export function parseCsv(text, options = {}) {
  const delimiter = delimiterOf(options);
  let input = String(text ?? '');
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);
  if (input.length === 0) return [];

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let endedWithBreak = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    endedWithBreak = false;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; continue; }
        inQuotes = false;
        continue;
      }
      field += ch;
      continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (ch === '\r' && input[i + 1] === '\n') i++;
      endedWithBreak = true;
      continue;
    }
    field += ch;
  }
  if (inQuotes) throw new SyntaxError('unterminated quoted field');
  if (!endedWithBreak || row.length > 0 || field !== '') {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function stringifyCsv(rows, options = {}) {
  const delimiter = delimiterOf(options);
  const quote = '"';
  return (rows ?? []).map(record => (record ?? []).map((value, index) => {
    const text = value === null || value === undefined ? '' : String(value);
    const needsQuoting = text.includes(delimiter) || text.includes(quote) || text.includes('\n') || text.includes('\r')
      || (text === '' && record.length === 1);
    if (needsQuoting) return quote + text.replaceAll(quote, quote + quote) + quote;
    return text;
  }).join(delimiter)).join('\r\n');
}
