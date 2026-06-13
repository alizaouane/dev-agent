# {{feature_title}} Implementation Plan

> **For agentic workers:** the dev-agent engine implements this plan via the consumer repo's GitHub Actions workflow `phase-implement.yml`. The implementation agent reads this plan task-by-task during the implement phase.

**Goal:** <one sentence>

**Architecture:** <2-3 sentences — matches the spec's Architecture section>

**Tech Stack:** <key technologies + libraries from the existing codebase>

<!--
Plan template used by skills/start-feature Phase 3. Mirrors the spec's
Files to Touch list — every entry under "Create" / "Modify" / "Test" in
the spec must appear in this plan, with a task that produces it.

The reviewer skill (skills/spec-review) cross-checks that:
  - every spec AC is referenced by at least one plan task
  - every spec "Files to Touch" path appears in this plan's File Structure
  - every task's steps are concrete (no "implement X" placeholders)
-->

---

## File Structure

<!-- Mirror the spec's Files to Touch list, with line ranges where relevant. -->

- Create: `exact/path/to/new-file.ts`
- Modify: `exact/path/to/existing.ts:LINE-RANGE`
- Test: `tests/exact/path/to/test.ts`

## Task 1: <component name> (AC: 1, 2)

**Files:**
- Create: `exact/path/to/file.ts`
- Test: `tests/exact/path/to/file.test.ts`

- [ ] Step 1: Write the failing test

  ```typescript
  // exact test code
  ```

- [ ] Step 2: Run test to confirm it fails

  ```bash
  npm test -- tests/exact/path/to/file.test.ts
  ```
  Expected: FAIL with "<expected error>"

- [ ] Step 3: Implement minimum to pass

  ```typescript
  // exact implementation
  ```

- [ ] Step 4: Run test to confirm green

  ```bash
  npm test -- tests/exact/path/to/file.test.ts
  ```
  Expected: PASS

- [ ] Step 5: Commit

  ```bash
  git add <files>
  git commit -m "feat(<scope>): <short message>"
  ```

## Task 2: ... (AC: 3)

<!--
Repeat the 5-step TDD pattern per task. Each step is one action
(2-5 minutes). Every code block is real, copy-pasteable code, not a
placeholder. The implement agent reads literally — vague steps
produce vague code.

For trivial work (single-line fix), one task with 3 steps (edit, test,
commit) is sufficient. Don't force a multi-task structure where it
adds no value.
-->
