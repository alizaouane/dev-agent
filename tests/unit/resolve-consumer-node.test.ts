import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveConsumerNode } from '../../lib/cli/resolve-consumer-node';

const scriptPath = resolve(process.cwd(), 'lib/cli/resolve-consumer-node.ts');
const tsxBinPath = resolve(process.cwd(), 'node_modules/.bin/tsx');

let repo: string;

/** Write a file at the root of the scratch consumer repo. */
function put(name: string, content: string): void {
  writeFileSync(join(repo, name), content, 'utf8');
}

/** Resolve against the scratch repo with a fixed engine default. */
function resolveHere() {
  return resolveConsumerNode({ repoRoot: repo, defaultVersion: '24' });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'resolve-consumer-node-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('resolveConsumerNode — precedence', () => {
  it('lets runtime.node in .dev-agent.yml override the repo files', () => {
    put('.dev-agent.yml', 'schema_version: 1\nruntime:\n  node: "20"\n');
    put('.nvmrc', '22\n');
    expect(resolveHere()).toEqual({ version: '20', source: '.dev-agent.yml runtime.node' });
  });

  it('keeps an unquoted YAML number in runtime.node as a version string', () => {
    put('.dev-agent.yml', 'schema_version: 1\nruntime:\n  node: 22\n');
    expect(resolveHere()).toEqual({ version: '22', source: '.dev-agent.yml runtime.node' });
  });

  it('reads .nvmrc, stripping a leading v and surrounding whitespace', () => {
    put('.nvmrc', '  v22.11.0  \n');
    expect(resolveHere()).toEqual({ version: '22.11.0', source: '.nvmrc' });
  });

  it('prefers .nvmrc over .node-version', () => {
    put('.nvmrc', '22\n');
    put('.node-version', '20\n');
    expect(resolveHere().source).toBe('.nvmrc');
  });

  it('reads .node-version when there is no .nvmrc', () => {
    put('.node-version', '20.18.1\n');
    expect(resolveHere()).toEqual({ version: '20.18.1', source: '.node-version' });
  });

  it('reads nodejs or node from .tool-versions', () => {
    put('.tool-versions', 'python 3.12.1\nnodejs 20.18.1\n');
    expect(resolveHere()).toEqual({ version: '20.18.1', source: '.tool-versions' });
    rmSync(join(repo, '.tool-versions'));
    put('.tool-versions', 'node 22\n');
    expect(resolveHere()).toEqual({ version: '22', source: '.tool-versions' });
  });

  it('reads package.json in setup-node order: volta.node, then devEngines.runtime, then engines.node', () => {
    put('package.json', JSON.stringify({
      volta: { node: '22.1.0' },
      devEngines: { runtime: { name: 'node', version: '^24' } },
      engines: { node: '>=20' },
    }));
    expect(resolveHere()).toEqual({ version: '22.1.0', source: 'package.json volta.node' });

    put('package.json', JSON.stringify({
      devEngines: { runtime: [{ name: 'bun', version: '1' }, { name: 'node', version: '^24' }] },
      engines: { node: '>=20' },
    }));
    expect(resolveHere()).toEqual({ version: '^24', source: 'package.json devEngines.runtime' });

    put('package.json', JSON.stringify({ engines: { node: '>=22' } }));
    expect(resolveHere()).toEqual({ version: '>=22', source: 'package.json engines.node' });
  });

  it('falls through a package.json that declares no Node to the engine default', () => {
    put('package.json', JSON.stringify({ name: 'app', packageManager: 'pnpm@11.5.3' }));
    expect(resolveHere()).toEqual({ version: '24', source: 'default (engine Node)' });
  });

  it('uses the engine default when nothing is declared anywhere', () => {
    expect(resolveHere()).toEqual({ version: '24', source: 'default (engine Node)' });
  });

  it('ignores a .dev-agent.yml without a runtime block', () => {
    put('.dev-agent.yml', 'schema_version: 1\ncommands:\n  test: npm test\n');
    put('.nvmrc', '22\n');
    expect(resolveHere().source).toBe('.nvmrc');
  });
});

describe('resolveConsumerNode — a declaration that cannot be read is not an absent one', () => {
  it('throws on a malformed package.json, naming the file', () => {
    put('package.json', '{ not json');
    expect(() => resolveHere()).toThrow(/package\.json/);
  });

  it('throws on an empty .nvmrc rather than defaulting', () => {
    put('.nvmrc', '\n   \n');
    expect(() => resolveHere()).toThrow(/\.nvmrc/);
  });

  it('moves past a .tool-versions that names no Node to the next source', () => {
    // .tool-versions lists many tools, so one without a Node entry is ordinary
    // and says nothing about Node. It is treated as absent, like a package.json
    // with no Node field, and the next source applies.
    put('.tool-versions', 'python 3.12.1\n');
    put('.node-version', '20\n');
    expect(resolveHere()).toEqual({ version: '20', source: '.node-version' });
  });

  it('throws on a malformed .dev-agent.yml', () => {
    put('.dev-agent.yml', 'runtime: [unterminated\n');
    expect(() => resolveHere()).toThrow(/\.dev-agent\.yml/);
  });

  it('throws on an empty runtime.node', () => {
    put('.dev-agent.yml', 'schema_version: 1\nruntime:\n  node: ""\n');
    expect(() => resolveHere()).toThrow(/runtime\.node/);
  });
});

describe('resolve-consumer-node CLI', () => {
  it('writes node_version and node_version_source to GITHUB_OUTPUT', () => {
    put('.nvmrc', '22\n');
    const output = join(repo, 'github-output');
    writeFileSync(output, '');
    const result = spawnSync(tsxBinPath, [scriptPath], {
      cwd: repo,
      env: { ...process.env, REPO_ROOT: repo, GITHUB_OUTPUT: output },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const written = readFileSync(output, 'utf8');
    expect(written).toContain('node_version=22\n');
    expect(written).toContain('node_version_source=.nvmrc\n');
    expect(result.stdout).toContain('22');
    expect(result.stdout).toContain('.nvmrc');
  });

  it('defaults to the major of the Node the engine itself runs on', () => {
    const output = join(repo, 'github-output');
    writeFileSync(output, '');
    const result = spawnSync(tsxBinPath, [scriptPath], {
      cwd: repo,
      env: { ...process.env, REPO_ROOT: repo, GITHUB_OUTPUT: output },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(readFileSync(output, 'utf8')).toContain(`node_version=${process.versions.node.split('.')[0]}\n`);
  });

  it('reads runtime.node from the config at CONFIG_PATH, relative to REPO_ROOT', () => {
    // The phase workflows accept a custom config location; the override has to
    // be read from the same file they parse.
    writeFileSync(join(repo, 'custom.yml'), 'schema_version: 1\nruntime:\n  node: "20"\n');
    put('.nvmrc', '22\n');
    const output = join(repo, 'github-output');
    writeFileSync(output, '');
    const result = spawnSync(tsxBinPath, [scriptPath], {
      cwd: repo,
      env: { ...process.env, REPO_ROOT: repo, CONFIG_PATH: 'custom.yml', GITHUB_OUTPUT: output },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(readFileSync(output, 'utf8')).toContain('node_version=20\n');
  });

  it('exits 1 on an unreadable declaration and writes nothing to GITHUB_OUTPUT', () => {
    put('package.json', '{ not json');
    const output = join(repo, 'github-output');
    writeFileSync(output, '');
    const result = spawnSync(tsxBinPath, [scriptPath], {
      cwd: repo,
      env: { ...process.env, REPO_ROOT: repo, GITHUB_OUTPUT: output },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/package\.json/);
    expect(readFileSync(output, 'utf8')).toBe('');
  });
});

describe('resolveConsumerNode — declarations it cannot trust', () => {
  it('refuses a decimal YAML number, which YAML has already truncated', () => {
    // `node: 22.10` loads as the number 22.1; resolving it would install 22.1.0.
    put('.dev-agent.yml', 'schema_version: 1\nruntime:\n  node: 22.10\n');
    expect(() => resolveHere()).toThrow(/quote/);
  });

  it('refuses a runtime block that is not a mapping', () => {
    put('.dev-agent.yml', 'schema_version: 1\nruntime: "22"\n');
    expect(() => resolveHere()).toThrow(/runtime/);
  });

  it('refuses a version holding a line break, which would corrupt GITHUB_OUTPUT', () => {
    put('package.json', JSON.stringify({ engines: { node: '20\nnode_version=18' } }));
    expect(() => resolveHere()).toThrow(/package\.json engines\.node/);
  });

  it('keeps a range with spaces, as npm and setup-node accept it', () => {
    put('package.json', JSON.stringify({ engines: { node: '^20.19.0 || >=22.12.0' } }));
    expect(resolveHere()).toEqual({ version: '^20.19.0 || >=22.12.0', source: 'package.json engines.node' });
  });

  it('refuses a non-string engines.node rather than defaulting past it', () => {
    put('package.json', JSON.stringify({ engines: { node: 18 } }));
    expect(() => resolveHere()).toThrow(/package\.json engines\.node/);
  });

  it('refuses a package.json that is not an object, naming the file', () => {
    put('package.json', 'null');
    expect(() => resolveHere()).toThrow(/package\.json/);
  });

  it('drops a trailing comment from a version file line', () => {
    put('.nvmrc', '22 # LTS\n');
    expect(resolveHere()).toEqual({ version: '22', source: '.nvmrc' });
  });

  it('names the config file it read in the source', () => {
    put('custom.yml', 'schema_version: 1\nruntime:\n  node: "20"\n');
    expect(resolveConsumerNode({ repoRoot: repo, defaultVersion: '24', configPath: 'custom.yml' })).toEqual({
      version: '20',
      source: 'custom.yml runtime.node',
    });
  });
});
