# {{feature_title}}

**Date:** {{YYYY-MM-DD}}
**Owner:** {{owner_name_or_email}}
**Status:** Draft (quick-dev path; no plan, no spec-review)

<!--
Quick-dev spec template used by skills/quick-dev for trivial work
(typos, copy fixes, one-line patches, single-icon swaps). Phase 2
brainstorming, Phase 3 plan writing, and Phase 3.5 spec-review are
all SKIPPED on this path — the implement agent reads this file
directly and derives its own task list. Speed matters here; the
full spec.template.md format is overkill for a 5-line change.

If the change isn't actually trivial, use templates/spec.template.md
instead. Heuristics for trivial:
  - Touches ≤2 files
  - Single user-visible AC
  - No new dependencies, env vars, migrations, or API contracts
  - The PM agent in start-feature Phase 1 estimated "<10 minutes"
-->

## What changes

<!-- One paragraph. The literal change in plain English. -->

<One paragraph describing the change.>

## Why

<!-- One paragraph. The motivation. Link the issue / log / scout finding
     that surfaced it if one exists. -->

<One paragraph describing why.>

## Acceptance Criteria

<!--
Typically 1-2 ACs for quick-dev work. Checkbox bullets, testable,
user-visible. Same format as the full spec template — the implement
agent runs the same validation either way, and Pillar 1's ACM
extractor (lib/acm.ts) ONLY matches `- [ ] ...` bullets under this
heading. Ordered lists (`1. AC-1:`) would leave ACM-gated repos
with zero extracted criteria.
-->

- [ ] AC-1: <user-visible outcome — what must be true after this ships>

## Files to Touch

<!--
Still required even for quick work. drift-check needs this list to
enforce scope; the implement agent honors "touch only files the
spec declares" against it. Use repo-relative paths.

Convention: each "Modify" entry ends with " — <one-line reason>".
-->

**Modify:**
- `path/to/file.ts` — <one-line reason>

**Tests:**
- `tests/path/to/file.test.ts` — <if a regression test makes sense; otherwise omit the section>

<!--
"Create" subsection omitted by default — quick-dev work rarely
adds new files. Add a "**Create:**" block if needed.
-->
