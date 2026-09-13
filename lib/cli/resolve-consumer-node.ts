#!/usr/bin/env tsx
/**
 * resolve-consumer-node — decide which Node a consumer repo's own commands run on.
 *
 * dev-agent's phase workflows run two kinds of code in one job: the engine's
 * CLIs, which need the Node the engine declares, and the consumer's own
 * install, tests, typecheck and build, which should run on the Node the
 * consumer's own CI uses. Running the consumer's commands on the engine's Node
 * produces passes and failures its real CI would not.
 *
 * The version is taken from, in order:
 * 1. `runtime.node` in the consumer's `.dev-agent.yml`, an explicit override;
 * 2. `.nvmrc`, then `.node-version`;
 * 3. a `nodejs` or `node` entry in `.tool-versions`;
 * 4. `package.json`, in the order actions/setup-node reads it: `volta.node`,
 *    then a `node` entry in `devEngines.runtime`, then `engines.node`;
 * 5. otherwise the major version of the Node the engine itself runs on.
 *
 * A declaration that exists but cannot be read — malformed YAML or JSON, an
 * empty `.nvmrc`, an empty `runtime.node` — is an error, never a fall-through.
 * Unknown is not the same as absent: defaulting there would run the consumer's
 * commands on a Node the repo never asked for, with nothing saying so.
 *
 * Environment:
 * - `REPO_ROOT` — the consumer checkout. Defaults to the working directory.
 * - `GITHUB_OUTPUT` — when set, `node_version` and `node_version_source` are
 *   appended to it for the next steps.
 *
 * Exit codes: 0 resolved, 1 a declaration could not be read.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

/** A resolved Node version and where it came from, for the run log. */
export interface ConsumerNode {
  /** A version or range actions/setup-node accepts, such as `22`, `22.11.0` or `>=22`. */
  version: string;
  /** Which declaration supplied it, or that the engine default applied. */
  source: string;
}

/** Inputs to the resolution. */
export interface ResolveConsumerNodeInput {
  /** Absolute path to the consumer repository checkout. */
  repoRoot: string;
  /** The version to use when the repository declares none: the engine's Node major. */
  defaultVersion: string;
}

/**
 * Read a text file when it exists.
 *
 * @param path - Absolute path.
 * @returns The contents, or null when the file is absent.
 */
function readIfPresent(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/**
 * Read `runtime.node` from `.dev-agent.yml`.
 *
 * @param repoRoot - The consumer checkout.
 * @returns The version, or null when the file or the key is absent.
 * @throws When the file is malformed YAML, or `runtime.node` is present but empty.
 */
function fromDevAgentConfig(repoRoot: string): string | null {
  const raw = readIfPresent(join(repoRoot, '.dev-agent.yml'));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new Error(`.dev-agent.yml could not be parsed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const node = (parsed as { runtime?: { node?: unknown } } | null)?.runtime?.node;
  if (node === undefined || node === null) return null;
  const version = typeof node === 'number' ? String(node) : typeof node === 'string' ? node.trim() : '';
  if (version === '') {
    throw new Error('.dev-agent.yml sets runtime.node but it is empty or not a version');
  }
  return version;
}

/**
 * Read a single-version file such as `.nvmrc` or `.node-version`.
 *
 * The first line that is neither blank nor a `#` comment is the version. A
 * leading `v` before a digit is dropped, since setup-node wants `22.11.0`.
 *
 * @param repoRoot - The consumer checkout.
 * @param name - The file name.
 * @returns The version, or null when the file is absent.
 * @throws When the file exists but holds no version.
 */
function fromVersionFile(repoRoot: string, name: string): string | null {
  const raw = readIfPresent(join(repoRoot, name));
  if (raw === null) return null;
  const line = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('#'));
  if (line === undefined) {
    throw new Error(`${name} exists but names no Node version`);
  }
  return line.replace(/^v(?=\d)/, '');
}

/**
 * Read a `nodejs` or `node` entry from `.tool-versions`.
 *
 * `.tool-versions` lists many tools, so a file without a Node entry says
 * nothing about Node and is treated as absent.
 *
 * @param repoRoot - The consumer checkout.
 * @returns The version, or null when the file or the entry is absent.
 */
function fromToolVersions(repoRoot: string): string | null {
  const raw = readIfPresent(join(repoRoot, '.tool-versions'));
  if (raw === null) return null;
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*(?:nodejs|node)\s+(\S+)/.exec(line);
    if (match) return match[1];
  }
  return null;
}

/**
 * Read the Node version from `package.json`, in actions/setup-node's order.
 *
 * @param repoRoot - The consumer checkout.
 * @returns The version and the field it came from, or null when the file or every field is absent.
 * @throws When the file is malformed JSON.
 */
function fromPackageJson(repoRoot: string): ConsumerNode | null {
  const raw = readIfPresent(join(repoRoot, 'package.json'));
  if (raw === null) return null;
  let manifest: {
    volta?: { node?: unknown };
    devEngines?: { runtime?: unknown };
    engines?: { node?: unknown };
  };
  try {
    manifest = JSON.parse(raw) as typeof manifest;
  } catch (err) {
    throw new Error(`package.json could not be parsed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof manifest.volta?.node === 'string' && manifest.volta.node.trim() !== '') {
    return { version: manifest.volta.node.trim(), source: 'package.json volta.node' };
  }
  const runtimes = manifest.devEngines?.runtime;
  const entries = Array.isArray(runtimes) ? runtimes : runtimes ? [runtimes] : [];
  for (const entry of entries as { name?: unknown; version?: unknown }[]) {
    if (entry?.name === 'node' && typeof entry.version === 'string' && entry.version.trim() !== '') {
      return { version: entry.version.trim(), source: 'package.json devEngines.runtime' };
    }
  }
  if (typeof manifest.engines?.node === 'string' && manifest.engines.node.trim() !== '') {
    return { version: manifest.engines.node.trim(), source: 'package.json engines.node' };
  }
  return null;
}

/**
 * Decide the Node version for a consumer repository's own commands.
 *
 * @param input - The checkout and the engine default.
 * @returns The version and its source.
 * @throws When a declaration exists but cannot be read.
 */
export function resolveConsumerNode(input: ResolveConsumerNodeInput): ConsumerNode {
  const { repoRoot, defaultVersion } = input;
  const override = fromDevAgentConfig(repoRoot);
  if (override !== null) return { version: override, source: '.dev-agent.yml runtime.node' };
  for (const name of ['.nvmrc', '.node-version']) {
    const version = fromVersionFile(repoRoot, name);
    if (version !== null) return { version, source: name };
  }
  const toolVersion = fromToolVersions(repoRoot);
  if (toolVersion !== null) return { version: toolVersion, source: '.tool-versions' };
  const fromManifest = fromPackageJson(repoRoot);
  if (fromManifest !== null) return fromManifest;
  return { version: defaultVersion, source: 'default (engine Node)' };
}

/**
 * CLI entry point: resolve, report, and hand the result to later steps.
 *
 * @throws When a declaration cannot be read; the entry guard turns that into exit 1.
 */
function main(): void {
  const repoRoot = process.env.REPO_ROOT ?? process.cwd();
  const defaultVersion = process.versions.node.split('.')[0];
  const resolved = resolveConsumerNode({ repoRoot, defaultVersion });
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `node_version=${resolved.version}\nnode_version_source=${resolved.source}\n`,
    );
  }
  process.stdout.write(`consumer Node ${resolved.version} (from ${resolved.source})\n`);
}

const invokedAsCli = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  try {
    main();
  } catch (err) {
    process.stderr.write(
      `resolve-consumer-node failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}
