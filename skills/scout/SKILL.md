---
name: scout
description: Use to discover candidate features by polling configured sources (GH issues, Vercel logs, Supabase logs, codebase audit, competitive feeds). Generates a daily digest issue with deduplication and rejection-suppression.
user-invocable: false
---

# scout

Internal skill that powers the daily proactive feature-discovery loop.

## Inputs (from `.dev-agent.yml.scout`)

```yaml
scout:
  enabled: true
  cron: "0 9 * * *"
  sources:
    - { kind: github_issues }
    - { kind: vercel_logs, project: "<vercel-project>" }
    - { kind: supabase_logs, project_ids: ["<id>", ...] }
    - { kind: codebase_audit, pitfalls_path: CLAUDE.md, max_age_days: 30 }
    - { kind: competitive, feeds: ["<rss-url>", ...] }
  suppression:
    track_rejections: true
    suppress_after_n_rejects: 3
```

## Behavior

1. **Per-source adapters** (each handled by a small TS module under `lib/scout/<kind>.ts` — implemented in Plan 1c):
   - `github_issues`: enumerate open issues with `triage` or `bug` labels not yet referenced from a spec.
   - `vercel_logs`: top errors from `vc logs --since=24h` filtered to non-trivial paths.
   - `supabase_logs`: project-specific error categories from the Supabase API.
   - `codebase_audit`: TODO/FIXME/HACK older than `max_age_days`, plus pitfalls_path entries that match recent diffs.
   - `competitive`: RSS items mentioning project keywords.

2. **Deduplication** — hash the title + first 200 chars of body; skip anything seen in the last 30 days.

3. **Suppression** — for each candidate, check if N similar (cosine ≥ 0.85 via Haiku embedding) candidates have been rejected via `/proposals`. If yes, suppress.

4. **Digest construction** — pick top 3–7 candidates by score (recency × severity × novelty). Render markdown table with `priority:p<N>` suggestions.

5. **Issue creation** — open one issue per surviving candidate with `kind:scout-proposal` + suggested priority + source label, plus a single `kind:scout-digest` summary issue linking them.

## Cost cap

Reads `cost_caps.scout_digest`. Default model: `claude-haiku-4-5`. Hits cap → emit partial digest, comment "truncated due to cost cap", exit 0.

## Implementation status

In Plan 1b, this SKILL.md exists as the contract. The TS adapters in `lib/scout/` and the workflow `dev-agent-scout.yml` ship in Plan 1c.
