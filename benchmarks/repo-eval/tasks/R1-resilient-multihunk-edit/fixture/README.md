# signal-engine

Small configuration engine shared by the scheduler and the ops pipeline.

- `src/limits.mjs` — concurrency and timeout limits parsed from operator input.
- `src/budget.mjs` — budget limit normalization shared with the dashboard.
- `src/format.mjs` — display helpers (stable, do not change).
- `policy.json` — deployed defaults, validated against `config.schema.json`.

Byte-format contract: `src/limits.mjs` and `src/budget.mjs` are checked out of
the ops pipeline with a UTF-8 BOM and CRLF line endings, and a few comment
lines carry trailing whitespace. Editors and tools working on these files must
preserve those bytes in untouched regions. `docs/BOUNDARY.md` tracks confirmed
defects pending a fix.
