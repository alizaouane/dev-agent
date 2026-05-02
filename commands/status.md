---
description: Tabular view of in-flight dev-agent features (state, age, cost, blockers)
argument-hint: "[--all] [--state=<label>]"
allowed-tools: Read Bash Grep
---

# /status

Shows the current dev-agent feature pipeline in this repo.

## Default output

By default, shows non-terminal states (everything except `state:done`, `state:abandoned`, `state:rolled-back`). Pass `--all` to include those, or `--state=<label>` to filter.

```
#    TITLE                                        STATE                    AGE    COST    BLOCKERS
142  add Stripe webhook idempotency check         state:pr-review          1d     $2.31   —
139  fix booking calendar timezone bug            state:staging-deployed    3h     $1.07   —
137  drop unused stripe_test_mode column          state:blocked            6h     $0.84   drift: 3 files outside spec
```

## Steps

1. `gh issue list --label state:* --json number,title,labels,createdAt,comments`. Filter to non-terminal states.
2. For each issue: extract latest telemetry comment (look for `🤖 Phase:` marker), pull cost.
3. Render the table.
4. If `artifacts.status_file` is configured and exists, also emit "Status file: <path>" footer.

## Failure modes

- No `.dev-agent.yml` → bail with a hint to run `/dev-agent-init`.
- No matching issues → emit "No active features." and exit.

## Implementation note

Fully functional in 1b — relies only on `gh` + lib/parse-config.
