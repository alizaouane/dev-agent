import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runExtract } from '../../lib/cli/acm-extract';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-extract-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function spec(name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

describe('runExtract', () => {
  it('flags missing-section when there is no acceptance-criteria heading', () => {
    const p = spec('a.md', '# Title\n\nProse only, no criteria heading.\n');
    const r = runExtract(p);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('missing-section');
    expect(r.criteria).toEqual([]);
  });

  it('returns ok with criteria + zero errors for a clean spec', () => {
    const p = spec(
      'a.md',
      `# Demo

## Acceptance criteria

- [ ] GET /health returns HTTP status 200 with body
- [ ] Cache hit metric is incremented on each request
- [ ] Sentry captures errors with feature=health label
`,
    );
    const r = runExtract(p);
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.criteria).toHaveLength(3);
    expect(r.criteria[0].id).toBe('AC-1');
    expect(r.lint.filter((x) => x.level === 'error')).toEqual([]);
  });

  it('flags lint-errors when criteria are too short or vague', () => {
    const p = spec(
      'a.md',
      `## Acceptance criteria

- [ ] tests
- [ ] Make it better and cleaner
`,
    );
    const r = runExtract(p);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('lint-errors');
    const errors = r.lint.filter((x) => x.level === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it('records the spec hash for downstream drift detection', () => {
    const content = '## Acceptance criteria\n\n- [ ] returns 200 with body ok\n';
    const p = spec('a.md', content);
    const r = runExtract(p);
    expect(r.spec_sha256).toMatch(/^[0-9a-f]{64}$/);
    // Same content → same hash
    const p2 = spec('b.md', content);
    expect(runExtract(p2).spec_sha256).toBe(r.spec_sha256);
  });

  it('throws when the spec file is missing', () => {
    expect(() => runExtract(path.join(dir, 'missing.md'))).toThrow(/spec not found/);
  });
});
