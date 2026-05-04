import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXPECTED_PROMPTS } from '../../lib/plugin-files';

const promptsDir = resolve(__dirname, '../../prompts');

describe('prompts/', () => {
  for (const name of EXPECTED_PROMPTS) {
    describe(`${name}.md`, () => {
      const path = resolve(promptsDir, `${name}.md`);

      it('file exists', () => {
        expect(existsSync(path)).toBe(true);
      });

      it('starts with an H1 role label', () => {
        const raw = readFileSync(path, 'utf8');
        const firstLine = raw.split('\n')[0];
        expect(firstLine).toMatch(/^# /);
      });

      it('has an "Inputs" section listing template variables', () => {
        const raw = readFileSync(path, 'utf8');
        expect(raw).toMatch(/##? Inputs/i);
        expect(raw).toMatch(/\{\{[a-z_.]+\}\}/);
      });

      it('has a "Required output" or output-format section', () => {
        const raw = readFileSync(path, 'utf8');
        expect(raw).toMatch(/##? Required output|##? Output format/i);
      });
    });
  }

  it('contains exactly the expected prompts (no extras, no missing)', () => {
    const files = readdirSync(promptsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
    expect(files).toEqual([...EXPECTED_PROMPTS].sort());
  });
});
