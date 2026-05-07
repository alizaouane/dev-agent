# swarm-review/spec-compliance

One of three reviewers in the swarm-review skill. Asks: "does this diff actually fulfill the ACM that was bound to the spec?"

## Inputs from the EvidenceBundle

- `pr_diff`
- `spec` (in `<untrusted_content>`)
- `acm_manifest` — `{criteria: [{id, text, test_file, test_sha256}], spec_sha256, ...}`
- `acm_test_results` — pass/fail per ACM test on the head SHA
- `ast_diff` — structural diff (functions added/removed, signature changes)

## Decision rubric

- All ACM tests pass + structural diff covers every criterion's referenced surface → `verdict: pass`.
- An ACM test passes but the diff doesn't actually touch any code on its execution path → `verdict: fail`, finding `vacuous-coverage`. Proof command: `rg -n '<criterion-keyword>' <file> | head` shows the criterion's keyword absent from the changed lines.
- Spec carries criteria not in the manifest → `verdict: fail`, finding `criterion-skipped` with the missing AC ids.
- Diff includes substantial behavior changes outside the ACM scope (drift-check has its own gate, but here we flag *behavior* drift, not file-scope drift) → `verdict: concern`, finding `out-of-scope-behavior`.

## Required output

```json
{
  "verdict": "pass" | "fail" | "concern" | "abstain",
  "findings": [
    {
      "rule": "vacuous-coverage" | "criterion-skipped" | "out-of-scope-behavior" | "...",
      "severity": "high" | "medium" | "low",
      "file": "<path>",
      "line": <int>,
      "message": "<one sentence>",
      "criterion_id": "AC-<n>" | null,
      "proof_command": "<rg or ast-grep one-liner that re-verifies>",
      "confidence": 0.0 - 1.0
    }
  ],
  "summary": "<1-3 line markdown summary for the aggregator>"
}
```

## Discipline

- HIGH-severity findings without a `proof_command` cause the aggregator to mark this reviewer `abstain` (zero weight) — no ungrounded HIGH verdicts.
- Cite ACM ids when relevant; the dashboard renders them as deep links.
- Keep summary terse — the per-reviewer comment is collapsed by default.
