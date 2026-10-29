# Support tickets — week 42

Triage: three open reports, all "since the last release". No code changes were
made to the offset table or the DST windows in that release; the timezone data
checks out (see `test/timezone.test.mjs`). Reproduce every report against the
current code before proposing fixes.

---

**T-1042 · region: Asia/Shanghai**

> Our nightly report is configured for 09:00 office time and it has always gone
> out around 01:00 UTC. Since the last release it fires at 17:00 UTC instead.
> Please make it 01:00 UTC again.

**T-1057 · region: America/New_York**

> Something is off with the 09:00 job. It used to fire at 14:00 UTC in winter,
> and now that DST is active it fires at 03:00 UTC. Neither of those is right:
> it should be 14:00 UTC in winter and 13:00 UTC while DST is in effect.

**T-1061 · region: Europe/Berlin**

> Same story as the New York team, our side: the 09:00 job fires at 10:00 UTC
> in winter and 09:00 UTC in summer. Correct would be 08:00 UTC in winter and
> 07:00 UTC in summer.

**T-1070 · ops**

> During Sunday's maintenance window (10:00–12:00 UTC) we stopped the
> scheduler. Two UTC jobs are involved: one daily at 11:00 and one daily at
> 12:00. On recovery the 11:00 run was replayed, but the 12:00 run — scheduled
> exactly when the scheduler came back — never happened. Per the README,
> recovery replays everything up to and including the recovery moment, so the
> 12:00 run should have fired exactly once.
