# {{feature_title}}

**Date:** {{YYYY-MM-DD}}
**Owner:** {{owner_name_or_email}}
**Status:** Draft (brainstorm complete; ready for plan)

<!--
Spec template used by skills/start-feature Phase 2. The reviewer skill
(skills/spec-review) checks that every section below has substantive
content, that Acceptance Criteria are independently testable, and that
Files to Touch resolves against the current working tree.

Don't delete sections. If a section genuinely doesn't apply, write
"N/A — <one-line reason>" so the reviewer sees it was considered.
-->

## Context

<!-- 2-4 paragraphs. Who has this problem, what they do today, what it costs. -->
<Problem statement; why this matters; what's broken or missing today.>

## Goals

<!-- User-facing outcomes. NOT "build feature X" — "user can do Y" or "X gets faster by Z%". -->

- <bullet>
- <bullet>

## Non-goals

<!-- Things people might reasonably expect this to include that we are explicitly skipping. Each one closes off a class of scope creep. -->

- <bullet — what we explicitly skip and why>

## Acceptance Criteria

<!--
Checkbox bullets, independently testable, user-visible. Each AC
should map to at least one concrete test (acm, smoke, tier-2-smoke,
or a unit test). spec-review will reject ACs that are vague ("works
correctly"), nested ("X happens, then Y, then Z" — split into three),
or untestable.

Use the `- [ ] AC-N: <text>` format. The Pillar 1 ACM extractor
(lib/acm.ts BULLET_RE = /^\s*-\s+\[([ x])\]\s+(.+)$/) parses these
checkbox bullets under the `## Acceptance Criteria` heading; ordered
lists (`1. AC-1:`) and prose bullets without `[ ]` are silently
ignored and would leave ACM-gated repos with zero extracted criteria.
-->

- [ ] AC-1: <user-visible outcome — what must be true after this ships>
- [ ] AC-2: <…>

## Architecture

<!-- 2-5 paragraphs. The shape of the answer. Not the line-by-line implementation (that's the plan). Include a diagram if the data flow is non-obvious. -->

<2-5 paragraphs describing the approach.>

## Files to Touch

<!--
Explicit paths. The implement agent is told "touch only files the spec
declares" (prompts/implement.md). If a path isn't listed here, the agent
won't touch it. drift-check fires on any out-of-list modification.

Use repo-relative paths. Group by action.

Convention: each "Modify" entry ends with " — <one-line reason>".
spec-review's `files.reason-per-modify` check flags a concern (soft
warning, not a blocker) when a Modify entry has no reason suffix.
-->

**Create:**
- `path/to/new-file.ts`
- `path/to/new-component.tsx`

**Modify:**
- `path/to/existing-file.ts` — <one-line reason>
- `path/to/existing-component.tsx` — <one-line reason>

**Tests:**
- `tests/path/to/file.test.ts`
- `e2e/path/to/flow.spec.ts`

## Implementation outline

<!-- Prose narrative — why each file changes, the data flow, the order of operations. The plan in Phase 3 derives task ordering from this. -->

<File-by-file or component-by-component sketch — enough that the plan in Phase 3 can be derived. NOT a step-by-step task list (that's Phase 3).>

## Edge cases

<!-- Adversarial input, partial failure, concurrent writes, retries, race conditions. The reviewer will hunt for missing ones. -->

- <bullet>

## Testing strategy

<!--
Map each AC to the layer that proves it. Layers available in dev-agent:
  - acm        — Acceptance Criteria Match tests (SHA-locked unit/integration)
  - smoke      — smoke-verify (light end-to-end on the implementation agent's branch)
  - tier-2     — tier2-smoke (heavier real-environment verification)
  - swarm-*    — swarm-spec-compliance / security-scout / regression-guard

Format: "AC-N → <layer>: <specific test scenario>"
-->

- AC-1 → <layer>: <test scenario>
- AC-2 → <layer>: <test scenario>

## Out of scope (defer)

<!-- Things we considered, decided to push to a follow-up. Naming them here prevents the implement agent from doing them anyway. -->

- <bullet — explicitly deferred work>
