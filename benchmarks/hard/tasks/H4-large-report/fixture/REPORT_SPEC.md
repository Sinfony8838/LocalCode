# Report specification — CI build events

`events.ndjson` contains one JSON object per line:

```json
{"ts":1773532800000,"region":"us-east","kind":"deploy","status":"ok","durationMs":1234,"bytes":512}
```

- `ts` — UTC millisecond timestamp, always aligned to a whole minute
- `region` — one of `ap-south`, `eu-west`, `us-east`, `us-north`, `us-west`
- `kind` — one of `build`, `deploy`, `lint`, `sync`, `test`, `verify`
- `status` — `ok`, `retry` or `fail`
- `durationMs`, `bytes` — positive integers

## Deliverable

Write `solve.mjs` (Node.js, no third-party dependencies) that reads
`events.ndjson` and writes `report.json` when run with `node solve.mjs`.
The verifier runs `node solve.mjs` with a 15-second wall-clock budget on the
full data set; a solution that does not finish in time scores zero on every
computed field. Also commit the `report.json` your run produced.

## report.json — exact fields

All numbers are JSON numbers (no strings, no trailing-zero formatting). Fields
must be spelled exactly and contain nothing extra.

| Field | Definition |
| --- | --- |
| `totalEvents` | number of events |
| `byStatus` | object with exactly the keys `ok`, `retry`, `fail` (in this order) mapping to counts |
| `byRegion` | object mapping region → event count, keys sorted A→Z, only the five known regions |
| `successRate` | `ok / totalEvents * 100` rounded half-up to 2 decimals |
| `p50DurationMs` | nearest-rank 50th percentile of `durationMs` over ALL events: sort ascending, take element at index `ceil(q/100 * N) − 1` |
| `p95DurationMs` | as above with q = 95 |
| `p99DurationMs` | as above with q = 99 |
| `slowestRegion` | region with the highest mean `durationMs`; ties broken alphabetically (first A→Z) |
| `topKind` | kind with the most events; ties broken alphabetically (first A→Z) |
| `bytesPerEvent` | total `bytes` / `totalEvents` rounded half-up to 2 decimals |
| `busiestMinute` | the minute with the most events as `YYYY-MM-DDTHH:MMZ` (UTC); ties broken by earliest minute |

Notes: rounding half-up must be exact (avoid float drift — e.g. compute with
integers where possible). Do not modify `events.ndjson` or `REPORT_SPEC.md`.
