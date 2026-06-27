import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { EXPECTED_SKILLS, USER_INVOCABLE_SKILLS } from '../../lib/plugin-files';

const skillsDir = resolve(__dirname, '../../skills');

function splitFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error('No frontmatter found');
  return { frontmatter: yaml.load(match[1]) as Record<string, unknown>, body: match[2] };
}

describe('skills/', () => {
  for (const name of EXPECTED_SKILLS) {
    describe(`/${name}`, () => {
      const path = resolve(skillsDir, name, 'SKILL.md');

      it('SKILL.md exists', () => {
        expect(existsSync(path)).toBe(true);
      });

      it('has frontmatter with name matching directory', () => {
        const raw = readFileSync(path, 'utf8');
        const { frontmatter } = splitFrontmatter(raw);
        expect(frontmatter.name).toBe(name);
      });

      it('has a description that says when to use it', () => {
        const raw = readFileSync(path, 'utf8');
        const { frontmatter } = splitFrontmatter(raw);
        expect(typeof frontmatter.description).toBe('string');
        expect((frontmatter.description as string).length).toBeGreaterThan(30);
      });

      it('has the expected user-invocable value', () => {
        const raw = readFileSync(path, 'utf8');
        const { frontmatter } = splitFrontmatter(raw);
        // Most dev-agent skills are internal (invoked by slash commands
        // / workflows, not by the user). `start-feature` is the
        // exception — it auto-activates on user intent in a wired-up
        // consumer repo, so it carries `user-invocable: true`.
        const expected = USER_INVOCABLE_SKILLS.has(name);
        expect(frontmatter['user-invocable']).toBe(expected);
      });

      it('body has at least one H2 section', () => {
        const raw = readFileSync(path, 'utf8');
        const { body } = splitFrontmatter(raw);
        expect(body.split('\n').some((l) => l.startsWith('## '))).toBe(true);
      });
    });
  }

  it('contains exactly the expected skills (no extras)', () => {
    const dirs = readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(dirs).toEqual([...EXPECTED_SKILLS].sort());
  });

  describe('/spec-review', () => {
    // The spec-review skill ships a separate checklist.md alongside its
    // SKILL.md, modeled on BMAD's bmad-create-story pattern. The skill
    // delegates the actual review questions to that file so the checklist
    // can be evolved without rewriting SKILL.md prose.
    const checklistPath = resolve(skillsDir, 'spec-review', 'checklist.md');

    it('ships checklist.md', () => {
      expect(existsSync(checklistPath)).toBe(true);
    });

    it('checklist.md references each required check category', () => {
      const raw = readFileSync(checklistPath, 'utf8');
      // Categories the SKILL.md and start-feature Phase 3.5 documentation
      // promise to enforce. If any of these disappears, the integration
      // contract is broken.
      for (const heading of [
        '## A. Spec structural integrity',
        '## B. Acceptance Criteria quality',
        '## C. Files to Touch quality',
        '## D. Plan ↔ Spec alignment',
        '## E. Disaster prevention',
        '## F. Implementation clarity',
        '## G. Pillar coverage',
      ]) {
        expect(raw).toContain(heading);
      }
    });
  });

  describe('/quick-dev', () => {
    // Fast-path skill for trivial work. The SKILL.md must encode the
    // bypass contract: phases 2 / 3 / 3.5 are skipped, the implement
    // agent derives its own task list, and the issue gets the
    // `quick-dev` label so the dashboard can surface the path.
    const skillPath = resolve(skillsDir, 'quick-dev', 'SKILL.md');
    const raw = existsSync(skillPath) ? readFileSync(skillPath, 'utf8') : '';

    it('SKILL.md references the quick-spec template path', () => {
      // The skill must point at templates/quick-spec.template.md
      // (not the full spec template) or the fast path leaks into the
      // heavyweight structure and defeats its own purpose.
      expect(raw).toContain('templates/quick-spec.template.md');
    });

    it('declares the "no plan, no spec-review" contract', () => {
      // The trade-off behind quick-dev is that the engine handles
      // task derivation. If this contract drifts, the start-feature
      // routing (Phase 1.5) becomes incoherent and the implement
      // agent receives ambiguous inputs.
      expect(raw).toMatch(/no\s+(separate\s+)?plan/i);
      expect(raw).toContain('spec-review');
      expect(raw).toMatch(/derives? (its )?own task list/i);
    });

    it('declares that the filed issue carries the quick-dev label', () => {
      // The dashboard's state:spec-ready card surfaces the
      // `quick-dev` label as a "fast path" pill. Without it the
      // approver has no signal that the heavyweight gates were
      // intentionally skipped.
      expect(raw).toContain('quick-dev');
      expect(raw).toContain('state:spec-ready');
    });
  });
});
