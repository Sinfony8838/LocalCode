# report.json specification

Each record in `builds.json` has `id`, `branch`, `status` (`passed`, `failed` or `cancelled`), `durationSeconds` (a number, or `null` for some cancelled builds) and `failedTests` (an array of test names; empty unless the build failed).

`report.json` must be a single JSON object with exactly these fields:

| Field | Definition |
| --- | --- |
| `totalBuilds` | Number of records. |
| `failedBuilds` | Number of records with status `failed`. |
| `failureRate` | `failed / (passed + failed)`; cancelled builds are excluded. A number rounded to 4 decimal places. |
| `medianDurationSeconds` | Median of `durationSeconds` over `passed` and `failed` builds (average the two middle values for an even count). |
| `slowestBuildId` | `id` of the build with the largest `durationSeconds` (any status; ignore `null`). |
| `byBranch` | Object keyed by branch name, each value `{ "builds": n, "failed": n }`, counting all statuses in `builds`. |
| `topFailingTest` | Test name appearing most often across `failedTests`; on a tie, the alphabetically first name. |
