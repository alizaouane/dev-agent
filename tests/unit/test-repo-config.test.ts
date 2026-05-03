import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

const repoRoot = resolve(__dirname, '../../examples/test-repo');

describe('examples/test-repo', () => {
  it('.dev-agent.yml exists and parses', () => {
    const path = resolve(repoRoot, '.dev-agent.yml');
    expect(existsSync(path)).toBe(true);
    expect(yaml.load(readFileSync(path, 'utf8'))).toBeDefined();
  });

  it('package.json declares mock scripts', () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.test).toMatch(/mock-test/);
    expect(pkg.scripts.build).toMatch(/mock-build/);
    expect(pkg.scripts.typecheck).toMatch(/mock-typecheck/);
  });

  it('all 5 mock scripts exist and are non-empty', () => {
    const scripts = ['mock-test', 'mock-build', 'mock-typecheck', 'mock-deploy-staging', 'mock-deploy-prod'];
    for (const s of scripts) {
      const path = resolve(repoRoot, 'scripts', `${s}.sh`);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8').length).toBeGreaterThan(20);
    }
  });

  it('all 6 wrapper workflows exist and reference reusable workflow paths', () => {
    const wrappersDir = resolve(repoRoot, '.github/workflows');
    const wrappers = readdirSync(wrappersDir).filter((f) => f.startsWith('dev-agent-') && f.endsWith('.yml'));
    expect(wrappers).toHaveLength(6);
    for (const w of wrappers) {
      const raw = readFileSync(resolve(wrappersDir, w), 'utf8');
      expect(raw).toMatch(/uses:\s*(\.\/\.github\/workflows\/(phase|orch)-|alizaouane\/dev-agent\/\.github\/workflows\/)/);
    }
  });
});
