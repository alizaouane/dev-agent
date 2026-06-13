# spec-review checklist

Fresh-context review of `{{spec_path}}` and `{{plan_path}}` before the implement agent runs. Each check below has an `id`, a question, and the verdict criteria. Record `pass` / `concern` / `fail` + a one-sentence note citing the spec/plan section.

**Mindset:** the original spec author was Claude. Claude writes plausible-looking prose that often hides shallow thinking. Your job is to surface what they missed. Adversarial, not adversarial-for-its-own-sake — every finding must cite a specific section.

---

## A. Spec structural integrity

### spec.required-sections
Does the spec contain ALL of: `## Context`, `## Goals`, `## Non-goals`, `## Acceptance Criteria`, `## Architecture`, `## Files to Touch`, `## Implementation outline`, `## Edge cases`, `## Testing strategy`, `## Out of scope`?

- `fail` if any section header is missing
- `concern` if a section is present but its body is empty or one line of filler
- `pass` if all present and substantive

### spec.context-grounded
Does `## Context` name a concrete current state (who has this problem today, what they do, what it costs)? Or is it generic hand-waving ("users want better X")?

- `fail` if no concrete current-state description
- `concern` if grounded but thin (one paragraph, no specifics)
- `pass` otherwise

### spec.non-goals-substantive
Does `## Non-goals` close off ≥1 concrete scope creep that a reasonable reader would otherwise expect? An empty or boilerplate Non-goals section is a red flag — every nontrivial feature has something it's NOT doing.

- `fail` if empty
- `concern` if generic ("v2 features", "out-of-scope work")
- `pass` if each non-goal is specific and named

---

## B. Acceptance Criteria quality

### ac.numbered
Are ACs numbered (`AC-1`, `AC-2`, …)?

- `fail` if unnumbered (the plan-task cross-check needs identifiers)
- `pass` otherwise

### ac.atomic
Is each AC a single user-visible outcome? Compound ACs ("X happens, then Y, then Z") must be split.

- `fail` if any AC contains "and then" / "after which" / multiple verbs in sequence
- `concern` if borderline
- `pass` if each is atomic

### ac.testable
For each AC: can you write a test that passes or fails on it? "Works correctly" / "feels responsive" / "is intuitive" are not testable.

- `fail` if any AC is subjective or untestable
- `pass` if all are concrete enough to test

### ac.user-visible
Each AC must describe what the USER sees or experiences, not what the SYSTEM does internally. "Endpoint returns 200" is implementation; "user sees confirmation banner within 2s" is acceptance.

- `concern` if any AC is implementation-flavored
- `pass` otherwise

---

## C. Files to Touch quality

### files.section-present
Does the spec have `## Files to Touch` with **Create**, **Modify**, and **Tests** subsections?

- `fail` if section missing
- `concern` if only one of the three subsections present
- `pass` if all three (any may be empty if genuinely N/A, e.g. no new files)

### files.create-no-collision
For each path under **Create**: does the file already exist on the consumer's default branch? If yes, the spec should say "Modify" instead.

- `fail` per colliding Create entry
- `pass` if no collisions

### files.modify-resolves
For each path under **Modify**: does the file exist on the consumer's default branch?

- `fail` per missing Modify path
- `pass` if all resolve

### files.tests-dir-resolves
For each path under **Tests**: does the parent directory exist? (The test file itself may not — that's what the implementation creates.)

- `concern` per missing parent directory (likely indicates the test path is wrong)
- `pass` otherwise

### files.reason-per-modify
Does each **Modify** entry include a one-line "— reason"?

- `concern` if any Modify entry has no reason
- `pass` if all have reasons

---

## D. Plan ↔ Spec alignment

### plan.tasks-reference-acs
Does every `## Task N:` header in the plan carry an `(AC: …)` annotation pointing at one or more ACs from the spec?

- `fail` per orphan task (no AC reference)
- `pass` if all annotated

### plan.acs-have-tasks
Does every AC in the spec appear in at least one plan task's `(AC: …)` annotation?

- `fail` per AC with no implementing task
- `pass` if all ACs covered

### plan.refs-resolve
Do all AC references in the plan match real AC numbers in the spec?

- `fail` per plan task referencing a non-existent AC (e.g. `(AC: 7)` when the spec has only AC-1..5)
- `pass` if all references resolve

### plan.file-structure-matches
Does the plan's `## File Structure` section list the same paths as the spec's `## Files to Touch`?

- `fail` if paths in spec are missing from plan or vice versa (a spec/plan mismatch is the single biggest source of off-scope implementation)
- `concern` if some paths in the plan have richer detail (e.g. line ranges) — that's fine, just flag for visibility
- `pass` if the sets match

---

## E. Disaster prevention (adapted from BMAD `bmad-create-story/checklist.md`)

### disaster.wheel-reinvention
Does the spec propose new code that duplicates functionality already present in the consumer repo? Search the codebase for the key nouns/verbs in the spec.

- `concern` per likely duplicate (cite the existing file)
- `pass` if no duplicates surfaced

### disaster.wrong-libraries
Does the plan introduce a library not already in the consumer's `package.json` / `pyproject.toml` / `go.mod`? New dependencies should be called out as a deliberate decision in the spec's Architecture section.

- `concern` per new library not justified in the spec
- `pass` if no new libs or all are justified

### disaster.wrong-locations
Do the file paths follow the consumer's existing convention (component locations, test locations, naming style)? Audit by sampling 3-5 nearby files in the same directories.

- `concern` per path that breaks convention
- `pass` if conventions followed

### disaster.regression-risk
Does any **Modify** entry touch a hot path (frequently changed file, file with many downstream imports)? If so, the spec should explicitly call out regression mitigation in `## Edge cases` or `## Testing strategy`.

- `concern` per hot-path modification without explicit regression coverage
- `pass` otherwise

### disaster.scope-creep
Are there plan tasks that go beyond what the ACs require? Compare task scope to AC scope.

- `fail` per task that implements something no AC references and the spec doesn't justify
- `pass` if scope matches

---

## F. Implementation clarity

### impl.no-vague-tasks
Does every plan task's steps show concrete code or commands? "Implement the function" / "Add error handling" without showing what is gate-failing.

- `fail` per task with placeholder steps
- `pass` if all steps are concrete

### impl.tdd-discipline
Does each non-trivial plan task follow the 5-step TDD pattern (failing test → run → implement → run → commit)? Trivial single-line fixes can use 3 steps (edit / test / commit).

- `concern` per task that skips the failing-test-first step
- `pass` if all non-trivial tasks are TDD-shaped

### impl.testing-strategy-mapped
Does `## Testing strategy` in the spec map each AC to a specific layer (acm / smoke / tier-2 / swarm-*)? Generic "we'll add tests" is insufficient.

- `concern` if mapping is missing or generic
- `pass` if each AC maps to a layer

---

## G. Pillar coverage (configured per consumer)

Skip this section if `.dev-agent.yml` was unreadable in Step 1.

### pillar.acm-coverage
If the consumer has the ACM pillar configured: does at least one AC map to `acm` in `## Testing strategy`?

- `concern` if ACM is configured but no AC routes to it
- `pass` otherwise

### pillar.smoke-coverage
If the consumer has smoke-verify configured: does at least one AC map to `smoke` or `tier-2`?

- `concern` if smoke is configured but no AC routes to it
- `pass` otherwise

### pillar.security-coverage
If the change touches auth / cookies / API routes / DB queries: does the spec's `## Edge cases` or `## Testing strategy` mention security review or route to `swarm-security-scout`?

- `concern` if security-sensitive change with no explicit security treatment
- `pass` otherwise

---

## Output

After running every check, the SKILL.md instructions tell you how to assemble the `.dev-agent/spec-review.json` and `.dev-agent/spec-review-summary.md` files. Don't restate them here.
