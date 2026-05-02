import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { EXPECTED_COMMANDS } from '../../lib/plugin-files';

const commandsDir = resolve(__dirname, '../../commands');

function splitFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error('No frontmatter found');
  return { frontmatter: yaml.load(match[1]) as Record<string, unknown>, body: match[2] };
}

describe('commands/', () => {
  for (const name of EXPECTED_COMMANDS) {
    describe(`/${name}`, () => {
      const path = resolve(commandsDir, `${name}.md`);

      it('file exists', () => {
        expect(existsSync(path)).toBe(true);
      });

      it('has parseable YAML frontmatter', () => {
        const raw = readFileSync(path, 'utf8');
        expect(() => splitFrontmatter(raw)).not.toThrow();
      });

      it('has a non-empty description in frontmatter', () => {
        const raw = readFileSync(path, 'utf8');
        const { frontmatter } = splitFrontmatter(raw);
        expect(typeof frontmatter.description).toBe('string');
        expect((frontmatter.description as string).length).toBeGreaterThan(10);
      });

      it('has an allowed-tools field listing at least one tool', () => {
        const raw = readFileSync(path, 'utf8');
        const { frontmatter } = splitFrontmatter(raw);
        expect(typeof frontmatter['allowed-tools']).toBe('string');
        expect((frontmatter['allowed-tools'] as string).trim().length).toBeGreaterThan(0);
      });

      it('body starts with an H1 matching the command name', () => {
        const raw = readFileSync(path, 'utf8');
        const { body } = splitFrontmatter(raw);
        const firstHeading = body.split('\n').find((l) => l.startsWith('# '));
        expect(firstHeading).toBeDefined();
        expect((firstHeading as string).toLowerCase()).toContain(name);
      });
    });
  }

  it('contains exactly the expected 8 commands (no extras)', () => {
    const files = readdirSync(commandsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
    expect(files).toEqual([...EXPECTED_COMMANDS].sort());
  });
});
