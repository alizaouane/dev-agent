---
name: drift-check
description: Use after implementation to detect scope drift — compares the actual diff against the spec's declared scope and flags out-of-scope changes (excluding configured trivial-cleanup categories).
user-invocable: false
---

# drift-check

Diff-vs-spec scope detector. Runs after the implementation phase produces a branch but before the PR is opened.

## Inputs

- `<spec>` — path to spec file at `<artifacts.specs_dir>/<file>.md`
- `<base-ref>` — the branch this work is based on (typically `main`)
- `<head-ref>` — the implementation branch
- `<config>` — the parsed `.dev-agent.yml` (for `guardrails.scope_creep_thresholds` and `trivial_cleanup_categories`)

## Behavior

1. Compute `git diff --name-only <base>...<head>` → set of changed files.
2. Parse the spec file; extract its "Critical files" or "Files modified" section. Compute the **declared scope** = set of file paths/globs the spec says will change.
3. Bucket each changed file into:
   - **In scope** — matches a glob in declared scope.
   - **Trivial cleanup** — single-line/whitespace-only changes, or matches a category in `guardrails.trivial_cleanup_categories` (formatting, import-sort, dead-code-removal, comment-fix). Allowed.
   - **Out of scope** — anything else.
4. Compute `loc_outside_spec_scope` = sum of `+` lines in out-of-scope files.
5. Apply thresholds from `guardrails.scope_creep_thresholds`:
   - `files_outside_spec_scope > 0` and not all trivial → fail.
   - `loc_outside_spec_scope > <threshold>` → fail.
6. On fail: emit a structured report (markdown), label the issue `state:blocked`, post the report as a comment.
7. On pass: emit "drift-check: clean" line for the telemetry comment.

## Output format (markdown report posted to issue)

```markdown
## drift-check: scope creep detected

Spec declared scope: 4 files
- src/auth/middleware.ts
- src/auth/session.ts
- tests/auth/middleware.test.ts
- docs/runbooks/auth.md

Out-of-scope changes:
- `src/payments/refund.ts` (+47 lines) — not declared
- `src/components/Header.tsx` (+12 lines) — not declared, not trivial

Trivial cleanup (allowed): 2 files (formatting, import-sort)

Action: state:blocked. Either narrow the diff or amend the spec and re-run.
```

## Cost

Uses `models.drift_detection` (default: `claude-haiku-4-5`) for the spec-parsing step. Pure-mechanical line counting is local TS, no model. Typical cost: <$0.05 per check.

## Implementation status

The TS implementation lives in Plan 1c (`lib/drift-check.ts` + invocation from `phase-implement.yml`). This SKILL.md is the contract.
