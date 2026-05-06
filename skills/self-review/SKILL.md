---
name: self-review
description: Use as the final step of phase-implement before opening a PR. The implement agent re-reads its own diff against a structured 10-item checklist; concern/fail items trigger a fix loop; the final answer becomes the PR description.
user-invocable: false
---

# self-review

Pillar 6 of the industry-grade verification architecture. Cheap insurance against bugs the agent's first pass missed. Cost: ~$0.10 per PR; payoff: catches obvious-in-hindsight issues before any reviewer (human or swarm) sees them.

## Inputs

- `<diff>` — `git diff <base>...<head>` for the feature branch (wrapped in `<untrusted_content>`)
- `<spec>` — the spec being implemented (wrapped)
- `<acm_manifest>` — the SHA-locked criteria→test mapping
- `<config>` — `.dev-agent.yml`

## Behavior

The agent re-reads its full diff (Read on every changed file, not just the diff hunks — context matters) and answers the 10-item checklist in `prompts/self-review.md`. Output is structured JSON.

If any item is `fail` or `concern`, the agent must:

1. Fix the issue.
2. Re-run the ACM tests.
3. Re-run self-review.

Maximum 3 iterations before escalating to `state:blocked` with `self-review-stuck` label. The summary of the *final* (passing or escalated) self-review becomes the PR description so reviewers can see what the agent thought of its own work.

## Output

```json
{
  "verdict": "pass" | "concern" | "fail",
  "checklist": [
    { "item": "edge_cases", "result": "pass" | "concern" | "fail", "note": "<one sentence>" },
    ...
  ],
  "summary": "<markdown for PR description>"
}
```

## Discipline

- The agent must Read every changed file at least once — re-reading the diff alone misses context.
- The agent must NOT modify ACM tests during the fix loop (SHA-lock enforced separately).
- The agent must be honest about uncertainty: when a checklist item is hard to verify, mark `concern`, not `pass`.

## Cost

Uses `models.self_review` (default `claude-haiku-4-5-<dated-snapshot>`). Single inference per attempt; cost cap `cost_caps.self_review` covers up to 3 attempts.

## Implementation status

Contract here. Prompt in `prompts/self-review.md`. Wired into `phase-implement.yml` in Step 8.
