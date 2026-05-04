import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';

import {
  loadDevAgentConfig,
  DEFAULT_SPECS_DIR,
  DEFAULT_PLANS_DIR,
} from '@/lib/dev-agent-config';

function mockOctokit(opts: {
  yaml?: string;
  status?: number;
  notFile?: boolean;
}): Octokit {
  const getContent = vi.fn(async () => {
    if (opts.status) {
      throw Object.assign(new Error('boom'), { status: opts.status });
    }
    if (opts.notFile) {
      return { data: [{ name: 'README.md' }] };
    }
    return {
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(opts.yaml ?? '', 'utf8').toString('base64'),
      },
    };
  });
  return { repos: { getContent } } as unknown as Octokit;
}

describe('loadDevAgentConfig', () => {
  it('returns defaults when .dev-agent.yml is absent (404)', async () => {
    const octokit = mockOctokit({ status: 404 });
    const cfg = await loadDevAgentConfig(octokit, 'q', 'r', 'main');
    expect(cfg).toEqual({ specs_dir: DEFAULT_SPECS_DIR, plans_dir: DEFAULT_PLANS_DIR });
  });

  it('returns defaults when getContent rejects with a non-404 (rate limit etc.)', async () => {
    const octokit = mockOctokit({ status: 429 });
    const cfg = await loadDevAgentConfig(octokit, 'q', 'r', 'main');
    expect(cfg).toEqual({ specs_dir: DEFAULT_SPECS_DIR, plans_dir: DEFAULT_PLANS_DIR });
  });

  it('returns defaults when getContent returns a directory listing (.dev-agent.yml is somehow not a file)', async () => {
    const octokit = mockOctokit({ notFile: true });
    const cfg = await loadDevAgentConfig(octokit, 'q', 'r', 'main');
    expect(cfg).toEqual({ specs_dir: DEFAULT_SPECS_DIR, plans_dir: DEFAULT_PLANS_DIR });
  });

  it('returns defaults when YAML is malformed', async () => {
    const octokit = mockOctokit({ yaml: 'not: valid: yaml: : :\n  - [' });
    const cfg = await loadDevAgentConfig(octokit, 'q', 'r', 'main');
    expect(cfg).toEqual({ specs_dir: DEFAULT_SPECS_DIR, plans_dir: DEFAULT_PLANS_DIR });
  });

  it('returns defaults when YAML has no artifacts block', async () => {
    const yaml = ['schema_version: 1', 'commands:', '  test: npm test'].join('\n');
    const octokit = mockOctokit({ yaml });
    const cfg = await loadDevAgentConfig(octokit, 'q', 'r', 'main');
    expect(cfg).toEqual({ specs_dir: DEFAULT_SPECS_DIR, plans_dir: DEFAULT_PLANS_DIR });
  });

  it('reads user-configured specs_dir + plans_dir', async () => {
    const yaml = [
      'schema_version: 1',
      'artifacts:',
      '  specs_dir: documentation/specs',
      '  plans_dir: documentation/plans',
    ].join('\n');
    const octokit = mockOctokit({ yaml });
    const cfg = await loadDevAgentConfig(octokit, 'q', 'r', 'main');
    expect(cfg).toEqual({
      specs_dir: 'documentation/specs',
      plans_dir: 'documentation/plans',
    });
  });

  it('falls back per-field when artifacts is partially specified', async () => {
    const yaml = ['artifacts:', '  specs_dir: specs'].join('\n');
    const octokit = mockOctokit({ yaml });
    const cfg = await loadDevAgentConfig(octokit, 'q', 'r', 'main');
    expect(cfg.specs_dir).toBe('specs');
    expect(cfg.plans_dir).toBe(DEFAULT_PLANS_DIR);
  });

  it('normalizes leading "./" and trailing "/" in user-configured paths', async () => {
    const yaml = [
      'artifacts:',
      '  specs_dir: ./specs/',
      '  plans_dir: plans//',
    ].join('\n');
    const octokit = mockOctokit({ yaml });
    const cfg = await loadDevAgentConfig(octokit, 'q', 'r', 'main');
    expect(cfg).toEqual({ specs_dir: 'specs', plans_dir: 'plans' });
  });

  it('falls back to defaults when an artifact path is empty/whitespace', async () => {
    const yaml = ['artifacts:', '  specs_dir: "   "', '  plans_dir: ""'].join('\n');
    const octokit = mockOctokit({ yaml });
    const cfg = await loadDevAgentConfig(octokit, 'q', 'r', 'main');
    // Empty strings fail the schema's `min(1)` so the whole artifacts block
    // is dropped — both fields fall back to defaults. That's the safest
    // outcome: a misconfigured value can't make a configured field disappear,
    // because there are no other fields under artifacts that this loader
    // reads today.
    expect(cfg).toEqual({ specs_dir: DEFAULT_SPECS_DIR, plans_dir: DEFAULT_PLANS_DIR });
  });

  it('ignores unknown fields in the artifacts block (forward compat)', async () => {
    const yaml = [
      'artifacts:',
      '  specs_dir: specs',
      '  plans_dir: plans',
      '  status_file: docs/status.md',
      '  runbooks_dir: runbooks',
      '  some_future_field: x',
    ].join('\n');
    const octokit = mockOctokit({ yaml });
    const cfg = await loadDevAgentConfig(octokit, 'q', 'r', 'main');
    expect(cfg).toEqual({ specs_dir: 'specs', plans_dir: 'plans' });
  });
});
