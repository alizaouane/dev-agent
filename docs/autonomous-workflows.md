# Autonomous workflow inventory

Operating Standard v5.1 §22.2: every unattended agent workflow is a governed
asset — it needs an owner, a trigger, a cap, and a **kill switch someone can**
**find at 2am**. This file is that inventory. It is generated from the workflow
files; regenerate it when you add or remove one.

## Why this exists

Two emergency mass-disables (2026-06-27 and 2026-07-27) happened because
spend was drained by cron- and comment-triggered runs while the only control
was an alert-only monthly cap — which reports a drain the morning after. The
pre-flight budget gate (§22.1) now refuses to start a phase once the month's
budget is spent. This inventory is the manual override for everything the gate
cannot anticipate.

## Kill switches

**Stop one workflow** (survives reboots; the fastest safe action):

```bash
gh workflow disable <file>.yml -R alizaouane/<repo>
gh workflow enable  <file>.yml -R alizaouane/<repo>   # to restore
```

**Stop everything in a repo** — disable every workflow that spends:

```bash
for w in $(gh workflow list -R alizaouane/<repo> --json name,path \
            -q '.[] | select(.path | test("phase-")) | .path' | xargs -n1 basename); do
  gh workflow disable "$w" -R alizaouane/<repo>
done
```

**Stop spend across every repo at once** — revoke the key. Blunt, immediate,
and it does not depend on GitHub being reachable or on any workflow honouring
a flag: rotate `ANTHROPIC_API_KEY` in the Anthropic console. Every phase run
then fails at the model call instead of spending.

**Cancel runs already in flight** (disabling only stops *new* runs):

```bash
gh run list -R alizaouane/<repo> --status in_progress --json databaseId \
  -q '.[].databaseId' | xargs -n1 gh run cancel -R alizaouane/<repo>
```

## Inventory

`spends` = invokes a model. `gated` = runs the §22.1 pre-flight budget gate.

| Workflow | Spends | Gated | Triggers | max-turns |
|---|---|---|---|---|
| `phase-acm.yml` | yes | yes | called,manual | 80 |
| `phase-bug-scout.yml` | yes | yes | called,manual | 30 |
| `phase-cleanup-scout.yml` | yes | yes | called,manual | 30 |
| `phase-evidence-collector.yml` | no | **no** | called,manual | — |
| `phase-implement.yml` | yes | yes | called,manual | 500 |
| `phase-pr-review.yml` | yes | yes | comment,pull_request | 30 |
| `phase-promote-to-prod.yml` | no | yes | called,manual | — |
| `phase-rollback.yml` | no | yes | called,manual | — |
| `phase-smoke-verify.yml` | no | yes | called,manual | — |
| `phase-staging-deploy.yml` | yes | yes | called,manual | 500 |
| `phase-swarm-review.yml` | yes | yes | called,manual | 30 |
| `phase-tier2-smoke.yml` | yes | yes | called,manual | 30 |
| `phase-unfinished-work-scout.yml` | yes | yes | called,manual | 30 |

## Known gaps

- **`--max-turns 500`** on the implement phase is not really a cap; §22.5 asks
  for the smallest value that lets the job finish. Worth measuring a few real
  runs and setting it from evidence.
- **The model is pinned as an alias** (`claude-sonnet-4-6`) rather than a dated
  snapshot. §6.3: aliases change behaviour and price underneath you.
- **Ungated workflows** in the table above still spend without a pre-flight
  check. Anything marked **no** should either be gated or documented as
  deliberately exempt.

## Known limitation: concurrent admission

Each phase reads month-to-date spend independently, so several starting at once
can each see the same total and each be admitted. The overshoot is bounded by
the sum of their caps — a few dollars against a $50 ceiling — not unbounded.
The failure this gate exists to stop is a cron firing daily for a week, and it
does stop that.

If a repo needs a hard ceiling rather than a bounded one, serialise the
spending workflows:

```yaml
concurrency:
  group: dev-agent-spend-${{ github.repository }}
  cancel-in-progress: false
```

That trades throughput for strictness, so it is opt-in.

## Adding a new autonomous workflow

Per §22.2 it does not ship until it has: an owner, its trigger (with debounce
or filter rules if event-driven), the model as a dated snapshot, a per-run turn
cap and timeout, an expected monthly cost, and a row in this table.

