import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const elicitDir = resolve(__dirname, '../../skills/elicit');

/**
 * Lightweight RFC-4180-ish CSV parser sufficient for methods.csv.
 * Methods.csv only uses straight commas as separators and never quotes
 * fields, so this is intentionally simple — pulling in a CSV dep
 * for one fixture file would be overkill. If a future method description
 * ever needs a literal comma, switch this to `csv-parse` or quote the
 * field; the test will fail loudly if a row's column count drifts.
 *
 * Handles both LF and CRLF line endings: git on Windows checkouts
 * with `core.autocrlf=true` would otherwise leave a trailing `\r` in
 * the last cell of each row, breaking the strict equality assertions
 * on header / categories / fallback method names.
 */
function parseCsv(raw: string): string[][] {
  return raw
    .trim()
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, '').split(','));
}

describe('skills/elicit', () => {
  it('SKILL.md exists', () => {
    expect(existsSync(resolve(elicitDir, 'SKILL.md'))).toBe(true);
  });

  it('methods.csv exists', () => {
    expect(existsSync(resolve(elicitDir, 'methods.csv'))).toBe(true);
  });

  describe('methods.csv', () => {
    const path = resolve(elicitDir, 'methods.csv');
    const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const rows = parseCsv(raw);
    const header = rows[0] ?? [];
    const data = rows.slice(1);

    it('has the BMAD header row (num,category,method_name,description,output_pattern)', () => {
      expect(header).toEqual([
        'num',
        'category',
        'method_name',
        'description',
        'output_pattern',
      ]);
    });

    it('contains the full BMAD library — 69 methods', () => {
      // BMAD ships 69 methods at the port time. If this number changes,
      // that means we either added a dev-agent-specific method
      // (intentional — update this assertion) or somehow lost one
      // (regression — investigate).
      expect(data.length).toBe(69);
    });

    it('every row has every expected column', () => {
      // Wrong column count is the single most common CSV-corruption
      // signal. Surface the row index in the failure message so the
      // author can find it fast.
      for (const [i, row] of data.entries()) {
        expect(
          row.length,
          `row ${i + 2} (num=${row[0] ?? '?'}) has ${row.length} columns, expected 5`,
        ).toBe(5);
      }
    });

    it('num column is a unique 1..N sequence', () => {
      const nums = data.map((r) => Number(r[0]));
      expect(nums).toEqual(Array.from({ length: nums.length }, (_, i) => i + 1));
    });

    it('every category referenced in skills/elicit/SKILL.md is present in the CSV', () => {
      // The skill's smart-selection step references these category
      // names verbatim. If the CSV diverges (renamed category) the
      // skill's instructions would silently fail to surface that
      // bucket. The category set must match SKILL.md's documented list.
      const csvCategories = new Set(data.map((r) => r[1]));
      const documentedCategories = [
        'advanced',
        'collaboration',
        'competitive',
        'core',
        'creative',
        'framing',
        'learning',
        'philosophical',
        'research',
        'retrospective',
        'risk',
        'technical',
      ];
      for (const cat of documentedCategories) {
        expect(csvCategories.has(cat), `missing category: ${cat}`).toBe(true);
      }
    });

    it('falls-back method names referenced in SKILL.md Failure modes exist in the CSV', () => {
      // SKILL.md's "methods.csv missing" failure path names 5 specific
      // methods as the hand-curated fallback. If those names ever drift
      // from what's actually in the CSV, the fallback would be broken.
      const methodNames = new Set(data.map((r) => r[2]));
      for (const name of [
        'First Principles Analysis',
        'Pre-mortem Analysis',
        'Stakeholder Lens Rotation',
        'Boundary & Edge Case Sweep',
        'Critique and Refine',
      ]) {
        expect(methodNames.has(name), `fallback method missing: ${name}`).toBe(
          true,
        );
      }
    });
  });

  describe('SKILL.md', () => {
    const path = resolve(elicitDir, 'SKILL.md');
    const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';

    it('declares the BMAD MIT attribution at the bottom', () => {
      // Required by BMAD's MIT license — verbatim ports of methods.csv
      // need attribution. The Attribution section must mention BMAD's
      // skill name and the MIT license.
      expect(raw).toContain('## Attribution');
      expect(raw).toContain('bmad-advanced-elicitation');
      expect(raw).toContain('MIT');
    });

    it('documents the return-to-caller contract', () => {
      // This is the single property that lets start-feature safely
      // invoke elicit per-section without losing control. If the
      // contract text disappears, that's a regression that would
      // re-introduce the same problem start-feature avoids with
      // superpowers:brainstorming.
      expect(raw).toContain('returns control on `x`');
    });
  });
});
