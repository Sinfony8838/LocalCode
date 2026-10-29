# CSV toolkit — specification

Implement `parseCsv(text, options)` and `stringifyCsv(rows, options)` in `csv.mjs`. No third-party dependencies.

```js
import { parseCsv, stringifyCsv } from './csv.mjs';

parseCsv('name,note\n"Smith, John","said ""hi"""');
// → [['name', 'note'], ['Smith, John', 'said "hi"']]

stringifyCsv([['a,b', 'plain', 'q"q'], ['n\nl']]);
// → '"a,b",plain,"q""q"\r\n"n\nl"'
```

Shared option: `delimiter` — exactly one character, never `"` or a line break; anything else throws `RangeError`. Defaults to `','`.

## parseCsv

1. Returns an array of records, each record an array of string fields. No header handling, no type coercion, no trimming: field whitespace is kept as-is.
2. Records are separated by `\r\n` or `\n`. A line break at the very END of the input does not produce an extra record; an empty line anywhere else produces the record `['']`.
3. An empty input produces `[]`.
4. A field starting with `"` is quoted: it may contain the delimiter, doubled quotes (`""` → one literal `"`), and line breaks, which are preserved exactly (`\r\n` stays `\r\n`, `\n` stays `\n`). The quoted part ends at the next unpaired `"`.
5. A quote that does not start a field is a literal character, and characters after a closing quote (before the next delimiter/line break) are literal too: `a"b` → `a"b`, `"a"b` → `ab`.
6. Empty fields are preserved: `a,,c` → `['a', '', 'c']`; a quoted empty field `""` is also an empty field.
7. A leading U+FEFF byte-order mark is ignored.
8. An unterminated quoted field (EOF inside quotes) throws `SyntaxError`.

## stringifyCsv

1. `rows` is an array of records; values are coerced with `String()`, except `null` and `undefined` which become empty fields.
2. A field is wrapped in quotes only when it contains the delimiter, a `"`, `\r` or `\n`; quotes inside are doubled. Exception: a record that consists of exactly one empty field serializes as `""` (otherwise it could not survive a round trip). Everything else is written as-is.
3. Fields join with the delimiter, records join with `\r\n`, and there is NO trailing line break at the end.
4. Round trip: for any `rows` of strings, `parseCsv(stringifyCsv(rows))` deep-equals `rows`.
