import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { codebaseAuditAdapter } from '../../lib/scout/codebase-audit';

const fixturesDir = resolve(__dirname, '../fixtures/codebase-audit');

describe('codebaseAuditAdapter', () => {
  it('finds TODO and FIXME entries', async () => {
    const candidates = await codebaseAuditAdapter({
      kind: 'codebase_audit',
      pitfalls_path: 'CLAUDE.md',
      max_age_days: 30,
      _scan_root: fixturesDir,
    });
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    const titles = candidates.map((c) => c.title);
    expect(titles.some((t) => t.includes('refactor'))).toBe(true);
    expect(titles.some((t) => t.includes('leaks'))).toBe(true);
  });

  it('returns empty for a missing scan root', async () => {
    const candidates = await codebaseAuditAdapter({
      kind: 'codebase_audit',
      pitfalls_path: 'CLAUDE.md',
      max_age_days: 30,
      _scan_root: resolve(fixturesDir, 'nonexistent'),
    });
    expect(candidates).toEqual([]);
  });
});
