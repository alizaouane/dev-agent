---
name: acm
description: Use after the spec is approved to bind every acceptance criterion to an executable test. Extracts `## Acceptance criteria` bullets, runs the test-stub generator, SHA-locks the manifest, and returns the criteria→test mapping that phase-implement will gate on.
user-invocable: false
---

# acm — Acceptance-Criteria Manifest

Pillar 1 of the industry-grade verification architecture. Runs in `state:acm-building`, between `state:spec-ready` and `state:implementing`. Binds every spec acceptance criterion to a failing test before implementation starts so the agent cannot ship features that don't satisfy what the spec promised.

## Inputs

- `<spec_path>` — full path to the spec, typically `docs/specs/<YYYY-MM-DD>-<slug>.md`
- `<feature_branch>` — the branch the test stubs are being committed to
- `<config>` — parsed `.dev-agent.yml` (`audit_skills.acm`, `commands.test`)

## Behavior

1. Read the spec; call `extractAcceptanceCriteria()` from `lib/acm.ts`. Empty list → label `state:blocked`, post comment naming the missing section, exit.
2. Lint criteria via `lintCriteria()`. Any `level: error` → label `state:blocked` with the remediation list. Warnings advisory.
3. Compute `spec_sha256 = computeSha256(specContent)`.
4. Invoke the **acm-test-agent** skill (separate context — sees only the spec + the consumer's public API contract, never the implementation tree). Test-agent emits one failing test stub per criterion under `tests/acm/<issue>-<n>-<slug>.<ext>`.
5. Run `commands.test -- tests/acm/...` and assert all tests are red. If any pass on first run, the stub was vacuous — discard and retry up to `audit_skills.acm.max_iterations`.
6. **Mutation-kill gate**: for each generated test, run Stryker (TS/JS) / mutmut (Python) / PIT (JVM) scoped to the implementation files referenced. Each test must kill ≥1 mutant in its target file. Tests killing 0 mutants are discarded; retry within budget.
7. **5× flaky filter**: re-run each generated test 5 consecutive times. Discard if any run is non-deterministic.
8. Compute test SHAs via `computeFileHashes()`. Persist `.dev-agent/acm-manifest.json` with `{spec_path, spec_sha256, generated_at, criteria: [{id, text, raw, checked, test_file, test_name, test_sha256}]}`.
9. Validate via `validateManifest()`; any error → `state:blocked` with the failing list.
10. Trigger `acm-pass` to advance the state machine to `state:implementing`.

## Anti-cheating discipline

- Test-agent runs in a **separate context** from the implement-agent (Augment circular-validation fix). The implement-agent never sees the test-agent's prompt or scratchpad.
- Test files are SHA-locked the moment phase-acm completes; phase-implement's pre-PR gate verifies hashes have not changed. Mutation = `acm-tests-mutated` block.
- The implement-agent's tool allowlist excludes write access to `tests/acm/` (enforced by `guardrails.require_explicit_unlock`).

## Cost

Uses `models.acm` (default `claude-sonnet-4-6-<dated-snapshot>`) for the test-stub generation step. Mutation testing + flaky filter are deterministic — runtime cost only. Per-spec cost: ~$0.50–$1.00. Cost cap: `cost_caps.acm`.

## Implementation status

The pure-TS extractor / linter / hasher / validator is implemented in `lib/acm.ts` (Step 2a of the v1 build sequence). The CLI verifier is `lib/cli/acm-verify.ts` (Step 5). The phase workflow `phase-acm.yml` lands in Step 6.
