/** TypeScript adaptation of openai/codex powershell_tree_sitter.rs at
 * 970111f6cb62cc02fe36a82ea7d71b37a2889c97. Apache-2.0; see third_party/codex.
 * This parser only lowers literal commands. It NEVER establishes permission.
 */
import { createRequire } from 'node:module';
import { Parser, Language, type Node } from 'web-tree-sitter';

const require = createRequire(import.meta.url);
const allowedKinds = new Set(['program', 'statement_list', 'pipeline', 'pipeline_chain', 'pipeline_chain_tail', 'command', 'command_name', 'command_elements', 'command_argument_sep', 'command_parameter', 'generic_token', 'array_literal_expression', 'unary_expression', 'string_literal', 'verbatim_string_characters', 'expandable_string_literal', 'integer_literal', 'decimal_integer_literal', 'comment', 'empty_statement', 'expression_with_unary_operator']);
let language: Promise<Language> | undefined;
function getLanguage(): Promise<Language> {
  return language ??= (async () => {
    await Parser.init({ locateFile: () => require.resolve('web-tree-sitter/tree-sitter.wasm') });
    return Language.load(require.resolve('tree-sitter-powershell/tree-sitter-powershell.wasm'));
  })();
}
const whitespace = (char: string) => /\s/u.test(char);
const rejectedBare = (char: string) => "$@'\"(){}[];|&><,".includes(char);
const escapes: Record<string, string> = { '0': '\0', a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
function decodeEscape(char: string | undefined, next?: string): string {
  if (!char || char === 'e' || char === 'u' && next === '{') throw new Error('Unsupported escape');
  return escapes[char] ?? char;
}
function maskInlineParameters(script: string): string {
  const chars = script.split('');
  let start = 0;
  const visit = (end: number) => {
    const token = script.slice(start, end), equals = token.indexOf('=');
    if (token.startsWith('--') && equals > 2 && equals + 1 < token.length && [...token].every(char => !whitespace(char) && !rejectedBare(char) && char !== '`' && char !== '#')) chars[start + equals] = ' ';
  };
  for (let i = 0; i < script.length; i++) if (whitespace(script[i]) || '|&;#><(){}'.includes(script[i])) { visit(i); start = i + 1; }
  visit(script.length);
  return chars.join('');
}
function lowerCommand(text: string): string[] {
  const chars = [...text.trim()], words: string[] = [];
  let i = 0;
  while (i < chars.length) {
    while (i < chars.length && whitespace(chars[i])) i++;
    if (i === chars.length || chars[i] === '#') break;
    let value = '', bare = false;
    if (chars[i] === "'" || chars[i] === '"') {
      const quote = chars[i++]; let closed = false;
      while (i < chars.length) {
        const char = chars[i++];
        if (char === quote) {
          if (quote === "'" && chars[i] === "'") { value += "'"; i++; continue; }
          closed = true; break;
        }
        if (quote === '"' && char === '$') throw new Error('Dynamic string');
        if (quote === '"' && char === '`') { value += decodeEscape(chars[i], chars[i + 1]); i++; }
        else value += char;
      }
      if (!closed) throw new Error('Unterminated string');
    } else {
      bare = true;
      while (i < chars.length && !whitespace(chars[i])) {
        const char = chars[i++];
        if (char === '`') { value += decodeEscape(chars[i], chars[i + 1]); i++; continue; }
        if (rejectedBare(char)) throw new Error('Structural or dynamic word');
        value += char;
      }
    }
    if (i < chars.length && !whitespace(chars[i]) && chars[i] !== '#') throw new Error('Concatenated words');
    if (!value || value.includes('\0')) throw new Error('Empty or NUL word');
    if (bare && value.startsWith('-') && !value.startsWith('--') && value.includes(':')) throw new Error('Attached parameter');
    if (bare && /^[0-9]/.test(value) && !(value === '0' || /^[1-9][0-9]*$/.test(value))) throw new Error('Noncanonical number');
    words.push(value);
  }
  if (!words.length || words[0].toLowerCase() === 'using') throw new Error('Unsupported command');
  return words;
}
function covered(script: string, ranges: [number, number][]): boolean {
  let i = 0, range = 0, depth = 0, canChain = false, needsCommand = false;
  while (i < script.length) {
    if (ranges[range]?.[0] === i) { i = ranges[range++][1]; canChain = true; needsCommand = false; continue; }
    const char = script[i], next = i + 1;
    if (char === '\r' || char === '\n') { canChain = false; i = next; continue; }
    if (whitespace(char)) { i = next; continue; }
    if (char === ';') { if (needsCommand) return false; canChain = false; i = next; continue; }
    if (char === '(' && !canChain) { depth++; i = next; continue; }
    if (char === ')' && depth > 0 && !needsCommand) { depth--; i = next; continue; }
    if (char === '|' && canChain) { canChain = false; needsCommand = true; i += script[next] === '|' ? 2 : 1; continue; }
    if (char === '&' && canChain && script[next] === '&') { canChain = false; needsCommand = true; i += 2; continue; }
    const boundary = i === 0 || whitespace(script[i - 1]) || script[i - 1] === ';';
    if (char === '#' && !needsCommand && boundary) { const end = script.slice(next).search(/[\r\n]/); i = end < 0 ? script.length : next + end; continue; }
    if (script.startsWith('<#', i) && !needsCommand && boundary) { const end = script.indexOf('#>', next); if (end < 0) return false; i = end + 2; continue; }
    return false;
  }
  return range === ranges.length && !needsCommand && depth === 0;
}
export async function parsePowerShellCommands(script: string): Promise<string[][] | null> {
  // Local adapter bounds prevent excessive parser work; broader syntax remains opaque.
  if (!script || script.length > 64 * 1024 || /[\0‘’“”–—―]/u.test(script)) return null;
  let parser: Parser | undefined;
  let tree: ReturnType<Parser['parse']> | undefined;
  try {
    const grammar = await getLanguage();
    parser = new Parser(); parser.setLanguage(grammar);
    tree = parser.parse(maskInlineParameters(script));
    if (!tree || tree.rootNode.hasError) return null;
    const all: Node[] = [tree.rootNode];
    while (all.length) {
      const node = all.pop()!;
      if (node.isNamed && !allowedKinds.has(node.type)) return null;
      if (node.type === 'comment' && script.slice(node.startIndex, node.endIndex).trimStart().toLowerCase().startsWith('#requires')) return null;
      all.push(...node.namedChildren.filter((child): child is Node => child !== null));
    }
    const nodes: Node[] = [], stack = [tree.rootNode];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.type === 'command') nodes.push(node);
      else stack.push(...node.namedChildren.filter((child): child is Node => child !== null).reverse());
    }
    if (!nodes.length) return null;
    const ranges = nodes.map(node => [node.startIndex, node.endIndex] as [number, number]);
    if (!covered(script, ranges)) return null;
    return nodes.map(node => lowerCommand(script.slice(node.startIndex, node.endIndex)));
  } catch { return null; }
  finally { tree?.delete(); parser?.delete(); }
}
