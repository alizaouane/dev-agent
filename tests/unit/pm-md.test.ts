import { describe, it, expect } from 'vitest';
import { parsePmMd, serializePmMd } from '../../lib/pm-md';
import { pmFrontmatterSchema } from '../../lib/pm-md-schema';

describe('parsePmMd', () => {
  it('parses a typical pm.md with frontmatter + body', () => {
    const raw = `---
goals:
  near_term: "Ship instructor onboarding by EOQ2"
avoid:
  - "operational complexity for the studio owner"
last_updated: "2026-05-04"
---

# PM notes

Background paragraph here.
`;
    const parsed = parsePmMd(raw);
    expect(parsed.frontmatter.goals?.near_term).toBe('Ship instructor onboarding by EOQ2');
    expect(parsed.frontmatter.avoid).toEqual(['operational complexity for the studio owner']);
    expect(parsed.frontmatter.last_updated).toBe('2026-05-04');
    expect(parsed.body).toContain('Background paragraph here');
  });

  it('treats a body-only file (no frontmatter delimiters) as valid', () => {
    const raw = '# Just notes\n\nNo frontmatter, that is fine.';
    const parsed = parsePmMd(raw);
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe(raw);
  });

  it('handles empty frontmatter (--- ---)', () => {
    const raw = `---
---

# Body

Content.
`;
    const parsed = parsePmMd(raw);
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body.trim()).toContain('Content.');
  });

  it('keeps the user\'s content when frontmatter is opened but never closed', () => {
    // Malformed: opening `---` with no closing one. Treat as body so we
    // don't lose the user's notes; they can fix the syntax to get
    // structured fields back.
    const raw = '---\ngoals:\n  k: v\n\nThis was meant to be body but no closing ---';
    const parsed = parsePmMd(raw);
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe(raw);
  });

  it('throws on invalid YAML in the frontmatter', () => {
    const raw = `---
goals:
  - this: is: not: valid: yaml: : :
---

body
`;
    expect(() => parsePmMd(raw)).toThrow(/not valid YAML|frontmatter/i);
  });

  it('throws on schema-violating frontmatter (e.g. wrong type)', () => {
    const raw = `---
goals:
  near_term: 12345
---

body
`;
    expect(() => parsePmMd(raw)).toThrow(/schema validation|frontmatter/i);
  });

  it('rejects a malformed last_updated date', () => {
    const raw = `---
last_updated: "Q2 2026"
---
`;
    expect(() => parsePmMd(raw)).toThrow(/YYYY-MM-DD|schema/i);
  });

  it('round-trips: serialize ∘ parse preserves frontmatter', () => {
    const raw = `---
goals:
  q2: "ship onboarding"
avoid:
  - "scope creep"
recent_decisions:
  - date: "2026-05-01"
    decision: "Rejected mobile app"
    reason: "Q4 instead"
last_updated: "2026-05-04"
---

# Body
`;
    const parsed = parsePmMd(raw);
    const serialized = serializePmMd(parsed);
    const reparsed = parsePmMd(serialized);
    expect(reparsed.frontmatter).toEqual(parsed.frontmatter);
  });

  it('serializes a body-only PmNotes without adding spurious frontmatter', () => {
    const out = serializePmMd({ frontmatter: {}, body: '# Just text' });
    expect(out).toBe('# Just text');
  });
});

describe('pmFrontmatterSchema', () => {
  it('accepts a fully empty object (every field optional)', () => {
    expect(pmFrontmatterSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a decision with revisit_after', () => {
    const result = pmFrontmatterSchema.safeParse({
      recent_decisions: [
        {
          date: '2026-05-01',
          decision: 'Defer',
          reason: 'Too much scope',
          revisit_after: '2026-10-01',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a decision with an empty `decision` string', () => {
    const result = pmFrontmatterSchema.safeParse({
      recent_decisions: [{ date: '2026-05-01', decision: '' }],
    });
    expect(result.success).toBe(false);
  });
});
