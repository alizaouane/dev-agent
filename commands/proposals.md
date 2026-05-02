---
description: List open scout-proposed features; lets you triage (accept → develop, reject → suppress)
argument-hint: "(no args)"
allowed-tools: Read Bash Grep
---

# /proposals

Shows all open `kind:scout-proposal` issues in the current repo so you can triage them.

## Output format

A table:

```
#  TITLE                                             AGE   PRIORITY   SOURCE
142  add Stripe webhook idempotency check            2d    p2         supabase_logs
137  drop unused stripe_test_mode column             5d    p3         codebase_audit
```

## Triage actions

- **Accept** → run `/develop <issue-url>` to start scoping.
- **Reject** → close the issue with comment `reject: <reason>`. The scout's suppression logic (`scout.suppression.track_rejections`) records this and suppresses similar future proposals after `suppress_after_n_rejects` hits.
- **Defer** → leave open; will appear in the next digest.

## Steps

1. `gh issue list --label kind:scout-proposal --state open --limit 50 --json number,title,createdAt,labels` to fetch.
2. Render the table; pull `priority:*` and source label off `labels`.
3. (Future) Allow inline triage via numbered selection — out of scope for 1b.

## Failure modes

- No open proposals → emit "No open proposals. Try `/digest` to run scout now." and exit.

## Implementation note

In 1b, this command is fully functional for the read side (`gh` enumeration). The scout that *populates* these proposals ships in 1c (or later). Until then, the list will typically be empty.
