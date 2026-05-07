# Verification gates — universal by default (v1.5+)

From **v1.5** onward the verification architecture (ACM, evidence-collector,
swarm-review) is **active by default on every connected consumer repo**.
There's no per-repo opt-in via `.dev-agent.yml` config.

Activation is controlled by the presence of one workflow file in each
consumer's `.github/workflows/` directory:
**`dev-agent-verification.yml`**.

If the file is present, the gates fire. If it's not, they don't.

## What happens when the gates run

### `/approve` on a `state:spec-ready` issue

The issue author commenting `/approve` triggers
`dev-agent-verification.yml`'s `acm` job, which calls
`alizaouane/dev-agent/.github/workflows/phase-acm.yml@v1` in **live
mode**. The phase:

1. Reads the spec from the issue body's `docs/specs/...md` reference.
2. Extracts the `## Acceptance criteria` bullets via the deterministic
   parser in `lib/acm.ts`. Lints them (rejects vague / too-short /
   non-observable). Lint errors → `state:blocked` + comment.
3. Invokes a real Claude Sonnet test-agent in an isolated context (the
   agent sees the spec + criteria but is steered away from
   implementation files via the system prompt).
4. The agent writes one failing test per criterion under `tests/acm/`
   plus a SHA-locked manifest at `.dev-agent/acm-manifest.json`.
5. `acm-verify --check-red` confirms each test fails on the current
   branch. Any non-failing test → block the gate.
6. Commits + pushes the manifest + tests to `feat/dev-agent-issue-N`,
   advances state to `state:implementing`.

### PR opened / synchronized on a `feat/dev-agent-issue-*` branch

Triggers two jobs in sequence:

1. **`evidence`** — runs gitleaks, Semgrep `p/owasp-top-ten`, `npm
   audit`. Findings packaged into a `verification-bundle-pr-N`
   artifact. **Fail-closed on HIGH-severity findings** (the PR is
   blocked at this gate; the bundle is uploaded so post-mortems work).
2. **`swarm-review`** — three sequential reviewer agents
   (spec-compliance, regression-guard, security-scout). Each gets a
   restricted read-only context, sees the PR diff, emits a structured
   verdict JSON via the Write tool. Aggregator (`lib/swarm-review.ts`)
   combines verdicts with weighted voting + evidence-grounding (HIGH
   findings without a working `proof_command` auto-downgrade to
   `concern`). Posts one consolidated PR comment + applies one label
   (`swarm-review:pass | concern | fail`). On `swarm-fail` the
   workflow exits non-zero — branch protection rules gating on this
   workflow's status block the merge automatically.

## Migration — existing consumers

The new code that landed when `v1` advanced is **passive** until the
verification wrapper file is added. Each existing consumer needs:

1. Copy the wrapper into `.github/workflows/`:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/alizaouane/dev-agent/v1/examples/web-app-template/.github/workflows/dev-agent-verification.yml \
     -o .github/workflows/dev-agent-verification.yml
   ```
2. Verify `ANTHROPIC_API_KEY` is set as a repo secret (most
   consumers already have it — same secret used by the existing
   `dev-agent.yml` workflow).
3. Commit + push.

That's it. The next `/approve` comment on a `state:spec-ready` issue
fires ACM. The next PR opened on `feat/dev-agent-issue-*` fires
evidence-collector + swarm-review.

For freshly-connected repos via `/dev-agent-init`, the wrapper lands
automatically (it's part of `examples/web-app-template/`).

## Cost

Per-feature rough cost when all gates run:

- ACM (Sonnet, ~30 turns generating failing tests): $0.50–1.00
- Evidence-collector (deterministic scanners, no LLM): runtime only
- Swarm-review (3× Haiku ~30 turns each): $0.30
- Self-review (1× Haiku, runs inside phase-implement): $0.10
- Implement (existing — Sonnet): $5–20 depending on spec size

Total verification overhead per feature: ~$1.50.

Repo-level monthly budget cap: set `cost_caps.monthly_budget_usd` in
`.dev-agent.yml` (default $200). The cost-watchdog CLI that enforces
the cap lands in v1.6 alongside the events.jsonl wiring through every
phase.

## Disabling

Two paths to deactivate the gates on a specific consumer:

1. **Quickest** — delete `.github/workflows/dev-agent-verification.yml`
   from the consumer's repo. No other change needed; existing
   `dev-agent.yml` (implement / staging-deploy / etc.) keeps working.
2. **Selective** — comment out the `acm:` / `evidence:` / `swarm-review:`
   jobs in the wrapper to disable individual gates while keeping others
   active.

## Forks (limitation)

PR events from forked repos run with read-only permissions to the
base repo. The swarm-review job will skip cleanly (gh CLI calls fail)
in that case. Internal-team PRs (same repo) work end-to-end. v1.6 may
add `pull_request_target` for fork support once the diff-handling
security review is done.

## Reverting a misbehaving gate

If a gate fails repeatedly on real PRs:

1. **Disable the gate first** (see "Disabling" above) to unblock the
   team.
2. **Open an issue** in this repo (alizaouane/dev-agent) with the
   workflow run logs.
3. **Pin the consumer's wrappers back to the prior `@v1`** if the
   issue is in the engine itself: edit the `uses:` line in
   `dev-agent-verification.yml` to point at a specific known-good
   commit SHA instead of `@v1`.

## What's deferred to v1.6+

- **EvidenceBundle in swarm-review** — currently reviewers see the PR
  diff only. v1.6 adds cross-workflow artifact download so reviewers
  consume the gitleaks/Semgrep findings as structured input.
- **Tier-2 Playwright smoke** — Pillar 7 ships in stub mode in v1.5;
  live Playwright probe is v1.7.
- **Mutation-kill gate in ACM** — `lib/cli/acm-verify.ts` already
  has the `CHECK_MUTATION_KILLS` plumbing; Stryker/mutmut wiring is
  v1.6.
- **Live eval harness** — `lib/cli/eval-run.ts --mode=live` (real
  Anthropic calls + 5-axis judge + bootstrap CIs) is v1.7.
- **Cost watchdog** — needs `lib/events.ts` wired through every
  phase first; lands in v1.6.
