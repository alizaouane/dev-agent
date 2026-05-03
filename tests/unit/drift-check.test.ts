import { describe, it, expect } from 'vitest';
import { classifyChangedFiles, type ClassificationInput } from '../../lib/drift-check';

const baseInput: ClassificationInput = {
  changed_files: [],
  declared_scope: ['src/auth/**', 'tests/auth/**'],
  trivial_categories: ['formatting', 'import-sort', 'dead-code-removal', 'comment-fix'],
  trivial_classifier: () => false,
  thresholds: { files_outside_spec_scope: 0, loc_outside_spec_scope: 50 },
  added_lines: {},
};

describe('classifyChangedFiles', () => {
  it('classifies in-scope files correctly', () => {
    const r = classifyChangedFiles({
      ...baseInput,
      changed_files: ['src/auth/middleware.ts', 'tests/auth/middleware.test.ts'],
      added_lines: { 'src/auth/middleware.ts': 30, 'tests/auth/middleware.test.ts': 50 },
    });
    expect(r.in_scope).toEqual(['src/auth/middleware.ts', 'tests/auth/middleware.test.ts']);
    expect(r.out_of_scope).toEqual([]);
    expect(r.verdict).toBe('clean');
  });

  it('flags out-of-scope files as scope_creep when thresholds exceeded', () => {
    const r = classifyChangedFiles({
      ...baseInput,
      changed_files: ['src/auth/m.ts', 'src/payments/refund.ts'],
      added_lines: { 'src/auth/m.ts': 10, 'src/payments/refund.ts': 100 },
    });
    expect(r.out_of_scope).toContain('src/payments/refund.ts');
    expect(r.verdict).toBe('scope_creep');
  });

  it('treats trivial-classified files as allowed', () => {
    const r = classifyChangedFiles({
      ...baseInput,
      changed_files: ['src/auth/m.ts', 'src/util/format.ts'],
      added_lines: { 'src/auth/m.ts': 10, 'src/util/format.ts': 5 },
      trivial_classifier: (path) => path === 'src/util/format.ts',
    });
    expect(r.trivial).toContain('src/util/format.ts');
    expect(r.out_of_scope).toEqual([]);
    expect(r.verdict).toBe('clean');
  });

  it('verdict needs_review when below loc threshold but non-trivial', () => {
    const r = classifyChangedFiles({
      ...baseInput,
      changed_files: ['src/auth/m.ts', 'src/x/y.ts'],
      added_lines: { 'src/auth/m.ts': 10, 'src/x/y.ts': 30 },
      thresholds: { files_outside_spec_scope: 1, loc_outside_spec_scope: 50 },
    });
    expect(r.verdict).toBe('needs_review');
  });
});
