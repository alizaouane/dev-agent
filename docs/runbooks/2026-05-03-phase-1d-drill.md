# Phase 1d Lifecycle Drill

**Goal:** Exercise every spec acceptance criterion against the synthetic consumer end-to-end with live model invocation. Findings → gap-fix tasks → `v0.1.0` tag.

**Prereqs:**
- `ANTHROPIC_API_KEY` configured as a repo secret on `alizaouane/dev-agent`
- Working tree on `feat/phase-1d-live-and-drill` branch with the live wiring + drill bridge merged

## One-time setup: canonical labels

Run once before Scenario A so issue labels exist.

```bash
for state in proposed scoping spec-ready implementing pr-review staging-deployed ready-to-promote promoting done blocked abandoned rolled-back; do
  gh label create "state:$state" --repo alizaouane/dev-agent --color BFD4F2 --force
done
for kind in user-intent scout-proposal scout-digest hotfix; do
  gh label create "kind:$kind" --repo alizaouane/dev-agent --color D4C5F9 --force
done
for prio in p0 p1 p2 p3; do
  gh label create "priority:$prio" --repo alizaouane/dev-agent --color FBCA04 --force
done
```

## Drill scenarios

### Scenario A: Happy-path implement (live)

1. Create a test issue:
   ```bash
   gh issue create --repo alizaouane/dev-agent \
     --title "drill: A1 happy-path implement" \
     --body "Synthetic feature for drill A1." \
     --label "kind:user-intent,state:spec-ready"
   # Note the issue number; we'll call it $A1
   ```
2. Dispatch phase-implement via the drill bridge (live mode):
   ```bash
   gh workflow run dev-agent-drill.yml --repo alizaouane/dev-agent \
     -f phase=implement \
     -f issue_number=$A1 \
     -f invocation_mode=live
   ```
3. Watch the run:
   ```bash
   gh run watch --repo alizaouane/dev-agent
   ```
4. Verify:
   - [ ] Run completes with conclusion: success
   - [ ] Issue $A1 has a comment starting with "🤖 Phase: implement" containing model + token + cost fields
   - [ ] Cost field shows a non-zero dollar value (proves live mode hit the API)

**Expected spend:** ~$0.05–0.20 depending on prompt size.

### Scenario B: Cost-cap abort

1. Create a test issue with the existing labels.
2. Temporarily edit `examples/test-repo/.dev-agent.yml` on a side branch to set `cost_caps.implement.dollars: 0.001` (don't merge).
3. Push the side branch and dispatch phase-implement against it; expect the workflow to fail with a clear cost-cap exceeded message.
4. Revert the edit; verify workflow runs green again.

**Expected outcome:** workflow fails fast, no telemetry comment posted, no PR opened.

### Scenario C: Guardrail blocked-paths

The synthetic consumer's `.dev-agent.yml` has `guardrails.blocked_paths: [secrets/**]`. The stub-mode implementation logic in 1d doesn't yet write files, so this scenario validates only that the guardrail config is parsed and surfaced in the prompt. A real-write test belongs in Phase 2 (Caliente integration) — note as known limitation in this drill.

### Scenario D: Drift-check synthetic scope-creep

1. Create a spec file at `examples/test-repo/docs/specs/drill-d.md` with a "Critical files" section listing only `src/foo.ts`.
2. On a side branch, modify `src/foo.ts` AND `src/bar.ts` (out of scope).
3. Manually run the drift-check CLI:
   ```bash
   SPEC_PATH=examples/test-repo/docs/specs/drill-d.md \
     BASE_REF=main \
     HEAD_REF=<side-branch> \
     CONFIG_PATH=examples/test-repo/.dev-agent.yml \
     npx tsx lib/cli/drift-check.ts
   ```
4. Verify: stdout JSON has `verdict: scope_creep` and process exit code 1.

### Scenario E: /abandon cleanup

1. Pick any open drill issue.
2. Manually apply `state:abandoned` label, remove all other `state:*` labels.
3. Verify: issue closes; existing audit trail preserved (comments retained).

This is a manual verification of the slash command's documented behavior; the actual `/abandon` command shipped in 1b is a markdown spec, not yet a runnable CLI in 1d.

### Scenario F: Rollback (stub-only in 1d)

1. Create a stand-in "shipped feature" issue with a synthetic linked PR comment ("PR: #999").
2. Dispatch phase-rollback via the drill bridge:
   ```bash
   gh workflow run dev-agent-drill.yml --repo alizaouane/dev-agent \
     -f phase=rollback -f issue_number=$F1 -f invocation_mode=live
   ```
3. Verify: workflow attempts to find the merge commit (will fail since #999 is fake), exits with a clear error message about missing PR.

A real rollback against a real merged PR is exercised in Phase 2 (Caliente).

## Findings log

After running the drill, append findings here as bullet points. Each finding becomes a gap-fix commit before tagging `v0.1.0`.

- (none yet — populated during drill execution)
