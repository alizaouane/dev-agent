import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXPECTED_TEMPLATES } from '../../lib/plugin-files';

const templatesDir = resolve(__dirname, '../../templates');

describe('templates/', () => {
  it('directory exists', () => {
    expect(existsSync(templatesDir)).toBe(true);
  });

  it('contains exactly the expected templates (no extras)', () => {
    const files = readdirSync(templatesDir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .sort();
    expect(files).toEqual([...EXPECTED_TEMPLATES].sort());
  });

  describe('spec.template.md', () => {
    const path = resolve(templatesDir, 'spec.template.md');
    const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';

    it('exists', () => {
      expect(existsSync(path)).toBe(true);
    });

    it('starts with the canonical front matter (title + Date + Owner + Status)', () => {
      // The start-feature Phase 2 documentation tells the author to fill
      // {{feature_title}}, {{YYYY-MM-DD}}, {{owner_name_or_email}}. If
      // any of these placeholder names drift, the SKILL.md guidance
      // becomes incorrect.
      expect(raw).toContain('# {{feature_title}}');
      expect(raw).toContain('**Date:** {{YYYY-MM-DD}}');
      expect(raw).toContain('**Owner:** {{owner_name_or_email}}');
      // Default is Draft — the spec is in progress until Phase 3.5's
      // adversarial review runs. CodeRabbit flagged that Approved as a
      // default makes in-progress specs look finalized too early.
      expect(raw).toContain('**Status:** Draft');
    });

    it('contains every section the spec-review skill enforces', () => {
      // These section headers are the contract between the spec
      // template and skills/spec-review/checklist.md (check
      // spec.required-sections). If a header is renamed in one place
      // and not the other, the reviewer will reject every spec.
      for (const heading of [
        '## Context',
        '## Goals',
        '## Non-goals',
        '## Acceptance Criteria',
        '## Architecture',
        '## Files to Touch',
        '## Implementation outline',
        '## Edge cases',
        '## Testing strategy',
        '## Out of scope',
      ]) {
        expect(raw).toContain(heading);
      }
    });

    it('Files to Touch section enumerates Create / Modify / Tests subgroups', () => {
      // Required by spec-review check files.section-present. The exact
      // **bold** markup is what the parser will key on.
      expect(raw).toContain('**Create:**');
      expect(raw).toContain('**Modify:**');
      expect(raw).toContain('**Tests:**');
    });

    it('Acceptance Criteria example shows numbered AC-N format', () => {
      // Required by spec-review check ac.numbered. The plan's task
      // annotations like `(AC: 1, 2)` reference these numbers.
      expect(raw).toMatch(/AC-1:/);
      expect(raw).toMatch(/AC-2:/);
    });

    it('Testing strategy guidance enumerates the configured pillar layer names', () => {
      // Required by spec-review check impl.testing-strategy-mapped.
      // If a new pillar is added (or one is renamed), this list must
      // change here AND in the checklist.
      for (const layer of ['acm', 'smoke', 'tier-2', 'swarm-']) {
        expect(raw).toContain(layer);
      }
    });
  });

  describe('plan.template.md', () => {
    const path = resolve(templatesDir, 'plan.template.md');
    const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';

    it('exists', () => {
      expect(existsSync(path)).toBe(true);
    });

    it('opens with the agentic-workers preface that the engine consumes', () => {
      // The For-agentic-workers note tells dev-agent's
      // phase-implement.yml agent how to interpret the plan. If it
      // drifts, the implement prompt's expectations break.
      expect(raw).toContain('For agentic workers');
      expect(raw).toContain('phase-implement.yml');
    });

    it('contains File Structure + Task headers + 5-step TDD pattern', () => {
      // spec-review check plan.file-structure-matches keys on the
      // exact "## File Structure" heading.
      expect(raw).toContain('## File Structure');
      // spec-review check plan.tasks-reference-acs looks for the
      // `(AC: …)` annotation pattern after Task N: headers.
      expect(raw).toMatch(/## Task 1:.*\(AC:/);
      // impl.tdd-discipline expects every non-trivial task to show
      // failing-test → run → implement → run → commit.
      expect(raw).toContain('Write the failing test');
      expect(raw).toContain('Run test to confirm it fails');
      expect(raw).toContain('Implement minimum to pass');
      expect(raw).toContain('Run test to confirm green');
      expect(raw).toContain('Commit');
    });
  });

  describe('quick-spec.template.md', () => {
    const path = resolve(templatesDir, 'quick-spec.template.md');
    const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';

    it('exists', () => {
      expect(existsSync(path)).toBe(true);
    });

    it('uses the same placeholder names as the full spec template', () => {
      // skills/quick-dev relies on identical placeholder names so the
      // fill logic can be shared between the two templates if needed.
      expect(raw).toContain('# {{feature_title}}');
      expect(raw).toContain('**Date:** {{YYYY-MM-DD}}');
      expect(raw).toContain('**Owner:** {{owner_name_or_email}}');
    });

    it('defaults Status to Draft and tags the quick-dev path', () => {
      // CodeRabbit's CR-7 on PR #114 established Draft as the right
      // default; the quick-dev annotation tells the dashboard which
      // path this spec came from.
      expect(raw).toContain('**Status:** Draft');
      expect(raw).toContain('quick-dev');
    });

    it('omits the heavyweight sections that quick-dev intentionally skips', () => {
      // Full spec.template.md has Implementation outline + Edge cases
      // + Testing strategy + Out of scope. Quick-dev's value
      // proposition is that the implement agent derives these at
      // runtime. If they leak back in, the template stops being a
      // "quick" path and the trade-off documented in skills/quick-dev
      // becomes false.
      expect(raw).not.toContain('## Implementation outline');
      expect(raw).not.toContain('## Edge cases');
      expect(raw).not.toContain('## Testing strategy');
      expect(raw).not.toContain('## Out of scope');
    });

    it('keeps Acceptance Criteria + Files to Touch (drift-check still applies)', () => {
      // Even on the fast path, the implement agent honors "touch
      // only files the spec declares" and drift-check fires on
      // out-of-list modifications. Both sections must survive.
      expect(raw).toContain('## Acceptance Criteria');
      expect(raw).toMatch(/AC-1:/);
      expect(raw).toContain('## Files to Touch');
      expect(raw).toContain('**Modify:**');
    });
  });
});
