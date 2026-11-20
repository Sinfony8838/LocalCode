# logpulse

Log-ops CLI used by the fleet's scheduled jobs and by humans in terminals.

## Commands

- `logpulse stats <file>` — line/byte counts for a text file (JSON on stdout).
- `logpulse rotate --dir <dir> --keep <n>` — keep the newest `n` `*.log` files
  (lexical order = age order), delete the rest (JSON on stdout).
- `logpulse report --out <file>` — write a JSON summary of `logs/`. If the
  target exists and `--force` is absent, the overwrite must be confirmed.

## CI contract

`docs/CI-GUIDE.md` is the authoritative contract for exit codes and the
non-interactive behaviour. The scheduled CI job runs with closed stdin, so the
report command must never block on terminal input there.
