---
name: swarm-review
description: Use on PR open to run three parallel reviewers (spec-compliance, regression-guard, security-scout) over a frozen evidence bundle. Each emits a structured verdict; aggregator validates evidence-grounded findings, applies weighted voting, escalates pass+fail mixes to a meta-reviewer.
user-invocable: false
---

# swarm-review

Pillar 2 of the industry-grade verification architecture. Runs in `state:swarm-reviewing`, between PR open and `state:pr-review`. Adversarially exercises every PR before a human reviewer is asked to look.

## Inputs

- `<pr_diff>` — `git diff <base>...<head>` (unified format, wrapped in `<untrusted_content>`)
- `<spec>` — the spec the diff is meant to implement (wrapped)
- `<acm_manifest>` — the SHA-locked criteria→test mapping
- `<evidence_bundle>` — the frozen output of `phase-evidence-collector` (gitleaks, Semgrep, `npm audit`, CodeQL, AST diff, callgraph delta, ACM-pass map)
- `<repo_claude_md>` — the repo's `CLAUDE.md` if any (no other repo state)
- `<config>` — `.dev-agent.yml` (`audit_skills.swarm`)

## Architectural shape

This is the **specialized-passes-pattern**: read-only inference passes over an immutable shared context. NOT multi-agent collaboration in Cognition's sense — reviewers do not write code, do not coordinate, do not share intermediate state. They emit structured findings that a deterministic aggregator combines.

The single risk Cognition's argument *does* warn about (independent retrieval producing divergent evidence) is eliminated by the `EvidenceBundle`: every reviewer reads from the same frozen artifact.

## Sub-skills

Each reviewer is a sibling markdown file in this directory:

- `spec-compliance.md` — does the diff actually fulfill the ACM?
- `regression-guard.md` — has anything that previously passed started failing or skipping?
- `security-scout.md` — interprets the deterministic scanner output + flags patterns the scanners missed (auth bypass, IDOR, business logic).

## Aggregation

`lib/swarm-review.ts` consumes all three reviewer outputs:

- Each reviewer's verdict is one of `pass | fail | concern | abstain`.
- A reviewer is forced to `abstain` if any of its HIGH-severity findings lack a `proof_command` that re-verifies the claim (CodeRabbit pattern).
- A `proof_command` returning no match → that finding auto-downgrades to `concern`.
- Weights from `audit_skills.swarm.reviewer_weights` (default 1.0 each, security_scout 1.5).
- ≥2 of 3 weighted-fail → `swarm-fail`. Single fail → `concern` (advisory).
- Mixed pass + fail → escalate to a single Sonnet **meta-reviewer** call that makes the final call with structured rationale.

## Embedding feedback filter (Greptile)

Before a finding is posted, it is embedded and compared against the team's persistent `findings.sqlite` store. If cosine-similar to ≥3 prior dismissals, suppress. If cosine-similar to ≥3 prior accept-and-fix outcomes, raise confidence.

## Output

A single aggregator comment on the PR plus `swarm-review:{pass|fail|concern}` labels. Detailed per-reviewer comments are also posted (collapsible) for triage.

## Cost

Three parallel `models.swarm_review` calls (default `claude-haiku-4-5-<dated-snapshot>`). Meta-reviewer (when invoked) is `models.meta_reviewer` (default `claude-sonnet-4-6-<dated-snapshot>`). Per-PR cost: ~$0.30 + $0.05 if meta. Cost cap: `cost_caps.swarm_review`.

## Kill switch

`DEV_AGENT_GATE_KILL_SWITCH=swarm` (repo secret) bypasses the gate. Use only during pipeline incident response; logged as a `kill-switch.activated` audit event.

## Implementation status

Contracts (this file + sub-files) land in Step 4. Aggregator + findings store land in Steps 10–11. Evidence collector lands in Step 9. Phase workflow lands in Step 12.
