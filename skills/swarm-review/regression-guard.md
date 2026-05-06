# swarm-review/regression-guard

One of three reviewers. Asks: "did this PR break anything that previously passed?"

## Inputs from the EvidenceBundle

- `pr_diff`
- `full_test_results_head` — `{file, name, status: pass|fail|skip}` for every test on head
- `full_test_results_base` — same shape, on `main` baseline
- `coverage_head_per_file` / `coverage_base_per_file` — touched-file coverage deltas

## Decision rubric

- No new failures, no new skips, no coverage regression on touched files → `verdict: pass`.
- Any test that passed on `base` now fails on `head` → `verdict: fail`, one finding per regression.
- Skip count increased on `head` → `verdict: fail`, finding `skip-introduced` (skipping a failing test == regressing).
- Coverage decrease > 2 percentage points on a touched file → `verdict: concern`, finding `coverage-regression`.
- Test was modified AND the assertion was relaxed (regex check via ast-grep) → `verdict: concern`, finding `test-weakened`.

## Required output

```json
{
  "verdict": "pass" | "fail" | "concern" | "abstain",
  "findings": [
    {
      "rule": "test-newly-failing" | "skip-introduced" | "coverage-regression" | "test-weakened" | "...",
      "severity": "high" | "medium" | "low",
      "file": "<test path>",
      "line": <int>,
      "message": "<one sentence>",
      "test_name": "<test name>" | null,
      "proof_command": "<command to re-verify>",
      "confidence": 0.0 - 1.0
    }
  ],
  "summary": "<1-3 line markdown summary>"
}
```

## Discipline

- Distinguish flaky regressions: if a test transitions pass→fail→pass across reruns within the same PR, mark `severity: low` and `rule: flaky-suspect`, do not block.
- HIGH-severity (real regression) without `proof_command` → aggregator forces `abstain`.
