# Eval framework — Pillar 9

Corpus + harness for measuring the verification system's reliability
(METR + Anthropic + SWE-bench Verified pattern). Every scenario is
frozen in source control; the harness runs the relevant reviewer
prompt against each case, compares to the expected verdict, and
computes precision / recall / F1 per family × per time-bucket.

## Layout

```
tests/evals/
├── README.md                  # this file
├── cases-schema.json          # JSON schema for case files
├── baselines.json             # committed metrics; CI fails on regression
└── corpus/
    └── <reviewer>/
        └── <family>/
            └── <case-name>.jsonl   # one or more scenarios per file
```

`<reviewer>` is one of `spec-compliance`, `regression-guard`,
`security-scout` (matching the prompts under `prompts/swarm-*.md`).
`<family>` describes the *kind* of judgment a scenario exercises:
`pass-clean`, `fail-real-issue`, `concern-marginal`, `injection-attempt`,
etc.

## Bucketed reliability

Every case carries a `bucket_minutes` field (5 / 30 / 120 / 360),
representing the human-minutes-to-fix the *underlying* issue would take
if real. The harness reports success-rate per bucket so we can see
where the agent stops being trustworthy ("the cliff" in METR's
terminology).

## Adding a scenario

1. Pick the `<reviewer>` your scenario tests.
2. Pick the `<family>` (or create a new one — a directory is enough).
3. Write a `.jsonl` file with one or more cases conforming to
   `cases-schema.json`. Each case needs:
   - `id` — globally unique; convention `<reviewer>/<family>/NN`
   - `reviewer` — repeats the directory's reviewer
   - `family` — repeats the directory's family
   - `bucket_minutes` — 5 | 30 | 120 | 360
   - `inputs` — the variables the reviewer prompt expects
     (`pr_diff`, `spec_text`, `acm_manifest`, etc.)
   - `expected_verdict` — `pass | fail | concern | abstain`
   - `expected_findings_count` — rough count, allows ±1 slack
   - `notes` — optional free-text rationale for human readers
4. Run `npx tsx lib/cli/eval-run.ts --mode=validate` to confirm the
   case parses + matches the schema before committing.

## Running the harness

```bash
# v1 — schema validation + stub-mode dispatch (no API calls; verifies
# every case parses and the wiring works end-to-end)
npx tsx lib/cli/eval-run.ts --mode=stub

# v1.1 — live mode invokes the real reviewer prompts against
# Anthropic's API, runs each scenario 3× with bootstrap CIs, applies
# the 5-axis judge (correctness, evidence-grounding, severity-
# calibration, false-positive-rate, signal-density), and compares
# against tests/evals/baselines.json. Lands once render-and-run.ts
# gains a ReviewerOutput-shape contract.
ANTHROPIC_API_KEY=... npx tsx lib/cli/eval-run.ts --mode=live --attempts=3
```

## Rebaselining

When prompts change deliberately, the new metrics become the baseline.
The rebaseline command requires a commit subject prefixed with
`BASELINE-CHANGE:` so the audit trail makes intent visible.

```bash
npx tsx lib/cli/eval-run.ts --mode=live --rebaseline
git commit -m "BASELINE-CHANGE: tighten spec-compliance prompt; F1 81 → 86"
```

## CI gate

The rule (per the plan, Pillar 9):

- Per-axis F1 drop > 5 points → fail
- Per-bucket success-rate drop > 10 points → fail
- New family appearing in the corpus without a baseline entry → warn

v1 ships the framework + a small seed corpus. Corpus growth is
operational work; aim for ≥30 cases across the three reviewers before
treating the F1 numbers as actionable signal (per Anthropic's "small
but high-effect set" rule of thumb).

## Minimal-harness baseline

Per METR / SWE-bench Verified discipline, a "naive Claude-Code-only"
run on the same eval set is the comparison point — without it we can't
justify the orchestration cost of the full pipeline. v1.1 adds this
mode: same cases, no ACM gate, no swarm, no tier-2 — just the
implement agent + post-hoc verdict scoring. Lands alongside the
live-mode harness wiring.
