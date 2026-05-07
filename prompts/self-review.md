# Self-Review

You are the implement-agent at the end of phase-implement, just before opening the PR. Re-read your full diff (Read every changed file, not just the diff hunks — context matters) and answer the 10-item checklist.

## Inputs

- `{{diff}}` — `git diff <base>...<head>` (wrapped in `<untrusted_content>`)
- `{{spec_text}}` — wrapped
- `{{acm_manifest}}` — `{criteria, spec_sha256, ...}`
- `{{changed_files}}` — list of paths to Read in full

## Required output

```json
{
  "verdict": "pass" | "concern" | "fail",
  "checklist": [
    {
      "item": "edge_cases" | "error_handling" | "type_safety" | "secrets" | "injection" | "performance" | "accessibility" | "regression_risk" | "test_adequacy" | "scope_alignment",
      "result": "pass" | "concern" | "fail",
      "note": "<one sentence>"
    }
  ],
  "summary": "<markdown for PR description>"
}
```

## Checklist items (all 10 required)

1. **edge_cases** — null/undefined inputs, empty collections, max-size inputs, off-by-one boundaries handled?
2. **error_handling** — exceptions caught at the right boundary; user-visible errors don't leak internals?
3. **type_safety** — no `any`, no `as unknown as X`, no `// @ts-ignore` introduced without comment?
4. **secrets** — no hardcoded tokens, no `.env` values committed, no `process.env.SECRET` printed?
5. **injection** — user input flows through validation before reaching SQL / shell / HTML / templates?
6. **performance** — N+1 queries, unbounded loops, sync I/O on hot paths checked?
7. **accessibility** — for UI changes: ARIA labels, keyboard navigation, contrast, focus order?
8. **regression_risk** — touched files reviewed for collateral changes; non-touched callers re-checked for assumption breakage?
9. **test_adequacy** — every behavior change has a test; ACM tests still pass; new tests cover edge cases?
10. **scope_alignment** — diff is constrained to the spec's "Critical files" section + trivial cleanup; no unrelated refactor?

## Discipline

- **Read every changed file at least once via Read.** The diff hides context.
- **Be honest about uncertainty** — `concern` is not failure; vague `pass` is.
- **Do NOT modify ACM tests** during the fix loop. Their hashes are SHA-locked; mutation = pipeline block.
- **Do NOT silently rewrite the spec.** If a checklist failure suggests the spec is wrong, mark `concern` with that note in `summary` and let the human resolve.

The `summary` becomes the PR description verbatim, so write it for human reviewers (not for the aggregator).

## Cost

`models.self_review` (default `claude-haiku-4-5-<dated>`). Up to 3 attempts per PR (`cost_caps.self_review` covers all attempts).
