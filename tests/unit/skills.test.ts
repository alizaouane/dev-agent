import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { EXPECTED_SKILLS } from '../../lib/plugin-files';

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

      it('has user-invocable: false (internal skill)', () => {
        const raw = readFileSync(path, 'utf8');
        const { frontmatter } = splitFrontmatter(raw);
        expect(frontmatter['user-invocable']).toBe(false);
      });

      it('body has at least one H2 section', () => {
        const raw = readFileSync(path, 'utf8');
        const { body } = splitFrontmatter(raw);
        expect(body.split('\n').some((l) => l.startsWith('## '))).toBe(true);
      });
    });
  }

  it('contains exactly the expected 4 skills (no extras)', () => {
    const dirs = readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(dirs).toEqual([...EXPECTED_SKILLS].sort());
  });
});
