# logpulse CI contract (v2.1)

Scheduled jobs run `logpulse` with **closed stdin and no TTY**. The contract
below is authoritative; the acceptance suite enforces it verbatim.

## Exit codes

| situation | exit code |
| --- | --- |
| command succeeded | `0` |
| non-interactive context tried to confirm an overwrite | `2` |
| overwrite declined (explicitly or by watchdog timeout) | `3` |
| usage error | `64` |

## `report --out <file>` overwrite confirmation

When the target exists and `--force` is absent, the CLI must confirm before
overwriting. Two contexts:

1. **Non-interactive** (`stdin` is not a TTY and `FORCE_INTERACTIVE` is not
   `1`): do not read stdin, do not spawn the prompt helper, do not wait for
   any event. Print a message containing `non-interactive` to stderr and exit
   `2` immediately. Piped stdin content (e.g. `echo y |`) must be ignored —
   the pipeline never confirms from piped input.
2. **Interactive** (`stdin` is a TTY, or `FORCE_INTERACTIVE=1` for tests):
   spawn `node scripts/asker.cjs` and wait for its answer behind a **3-second
   watchdog**. If the helper prints `y` in time, overwrite and exit `0`. If it
   prints `n` or the watchdog fires first, treat the answer as declined and
   exit `3`. The helper process must be killed when the watchdog fires — a
   stalled helper may never outlive the CLI.

## `scripts/asker.cjs` — protected child contract

The helper prints exactly one line, `y` or `n`, then exits. It waits for one
stdin line, and answers `n` after at most 10 seconds even if stdin never
speaks. This file is part of the contract — do not modify it. Your fix lives
in the CLI/core, not in the helper.

## Unchanged commands

`stats` and `rotate` keep their current output shape exactly (see the tests
under `test/stats.test.mjs` and `test/rotate.test.mjs`).
