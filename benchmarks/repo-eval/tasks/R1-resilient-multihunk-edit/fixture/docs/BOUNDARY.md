# Confirmed boundary defects (must-fix list)

All three defects were confirmed by the ops pipeline review. Fix them exactly
as specified below — the hidden acceptance suite checks each rule verbatim.

## 1. `parseConcurrency(value, options)` in `src/limits.mjs`

Current behaviour: `Math.floor(Number(value))`.

Required behaviour:

- numeric strings and numbers are floored to integers (`'4'` → `4`, `2.7` → `2`);
- anything non-finite (`NaN`, `Infinity`, unparsable strings) → `1`;
- values below `1` → `1`;
- values above `options.max` (default `8`) → capped at `max`.

## 2. `ceilTimeout(ms, options)` in `src/limits.mjs`

Current behaviour: floors to the quantum (`Math.floor(ms / quantum) * quantum`).

Required behaviour:

- round **up** to the next multiple of `options.quantum` (default `100`);
- never return less than one quantum (`100` when the default quantum is used);
- never exceed `options.cap` (default `5000`).

## 3. `normalizeLimit(n, options)` in `src/budget.mjs`

Current behaviour: `Number(n)`.

Required behaviour:

- non-finite input (`NaN`, `Infinity`, unparsable strings) → `null`;
- negative values → `0`;
- values above `options.max` (default `1000`) → capped at `max`;
- otherwise the numeric value itself.

## 4. `policy.json` updates

Deploy the two approved changes (validated by `config.schema.json`):

- `defaults.concurrencyLimit`: `4` → `6`;
- add `"trace": true` inside `defaults`.

Everything else in `policy.json` must keep its current value, and the file
must stay valid JSON.

## Byte-format reminder

`src/limits.mjs` and `src/budget.mjs` keep their UTF-8 BOM, CRLF line endings
and trailing whitespace on the marked comment lines. Do not reformat these
files; apply surgical edits only.
