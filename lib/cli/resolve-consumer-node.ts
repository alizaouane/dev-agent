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
 * - `CONFIG_PATH` — the dev-agent config, relative to `REPO_ROOT` unless
 *   absolute. Defaults to `.dev-agent.yml`, matching the phase workflows' input.
 * - `GITHUB_OUTPUT` — when set, `node_version` and `node_version_source` are
 *   appended to it for the next steps.
 *
 * Exit codes: 0 resolved, 1 a declaration could not be read.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
  /** The dev-agent config, relative to `repoRoot` unless absolute. Defaults to `.dev-agent.yml`. */
  configPath?: string;
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
 * Accept a declared version only when it is one non-blank token.
 *
 * Whitespace inside a value would split the `GITHUB_OUTPUT` line it is written
 * to, letting a declaration set outputs other than `node_version`.
 *
 * @param value - The trimmed declared value.
 * @param source - Where it came from, for the error message.
 * @returns The value unchanged.
 * @throws When the value is empty or holds whitespace.
 */
function usableVersion(value: string, source: string): string {
  if (!/^\S+$/.test(value)) {
    throw new Error(`${source} is not a usable Node version: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Read `runtime.node` from the dev-agent config.
 *
 * @param repoRoot - The consumer checkout.
 * @param configPath - The config file, relative to `repoRoot` unless absolute.
 * @returns The version, or null when the file or the key is absent.
 * @throws When the file is malformed YAML, `runtime` is not a mapping, or
 *   `runtime.node` is present but empty, not one token, or a non-integer number
 *   (YAML has already read `22.10` as 22.1, so the intended version is lost).
 */
function fromDevAgentConfig(repoRoot: string, configPath: string): string | null {
  const raw = readIfPresent(resolve(repoRoot, configPath));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new Error(`${configPath} could not be parsed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const runtime = (parsed as { runtime?: unknown } | null)?.runtime;
  if (runtime === undefined || runtime === null) return null;
  if (typeof runtime !== 'object' || Array.isArray(runtime)) {
    throw new Error(`${configPath} sets runtime but it is not a mapping`);
  }
  const node = (runtime as { node?: unknown }).node;
  if (node === undefined || node === null) return null;
  if (typeof node === 'number' && !Number.isInteger(node)) {
    throw new Error(
      `${configPath} sets runtime.node to the number ${node}; quote the version (for example "22.10"), since YAML drops trailing zeros`,
    );
  }
  const version = typeof node === 'number' ? String(node) : typeof node === 'string' ? node.trim() : '';
  if (version === '') {
    throw new Error(`${configPath} sets runtime.node but it is empty or not a version`);
  }
  return usableVersion(version, `${configPath} runtime.node`);
}

/**
 * Read a single-version file such as `.nvmrc` or `.node-version`.
 *
 * The first line that is neither blank nor a `#` comment is the version; a
 * trailing `# comment` on that line is dropped. A leading `v` before a digit is
 * dropped too, since setup-node wants `22.11.0`.
 *
 * @param repoRoot - The consumer checkout.
 * @param name - The file name.
 * @returns The version, or null when the file is absent.
 * @throws When the file exists but holds no version, or the version is not one token.
 */
function fromVersionFile(repoRoot: string, name: string): string | null {
  const raw = readIfPresent(join(repoRoot, name));
  if (raw === null) return null;
  const line = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)#.*$/, '').trim())
    .find((l) => l !== '');
  if (line === undefined) {
    throw new Error(`${name} exists but names no Node version`);
  }
  return usableVersion(line.replace(/^v(?=\d)/, ''), name);
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
 * @throws When the file is malformed JSON or not an object, or a Node field is
 *   present but not a one-token version string.
 */
function fromPackageJson(repoRoot: string): ConsumerNode | null {
  const raw = readIfPresent(join(repoRoot, 'package.json'));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`package.json could not be parsed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('package.json is not a JSON object');
  }
  const manifest = parsed as {
    volta?: { node?: unknown };
    devEngines?: { runtime?: unknown };
    engines?: { node?: unknown };
  };
  const volta = declared(manifest.volta?.node, 'package.json volta.node');
  if (volta !== null) return volta;
  const runtimes = manifest.devEngines?.runtime;
  const entries = Array.isArray(runtimes) ? runtimes : runtimes ? [runtimes] : [];
  for (const entry of entries as { name?: unknown; version?: unknown }[]) {
    if (entry?.name !== 'node') continue;
    const runtime = declared(entry.version, 'package.json devEngines.runtime');
    if (runtime !== null) return runtime;
  }
  return declared(manifest.engines?.node, 'package.json engines.node');
}

/**
 * Turn one optional `package.json` Node field into a resolution.
 *
 * @param value - The field's raw JSON value.
 * @param source - The field's name, used as the source and in errors.
 * @returns The resolution, or null when the field is absent.
 * @throws When the field is present but not a one-token version string.
 */
function declared(value: unknown, source: string): ConsumerNode | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`${source} is not a version string: ${JSON.stringify(value)}`);
  }
  return { version: usableVersion(value.trim(), source), source };
}

/**
 * Decide the Node version for a consumer repository's own commands.
 *
 * @param input - The checkout and the engine default.
 * @returns The version and its source.
 * @throws When a declaration exists but cannot be read.
 */
export function resolveConsumerNode(input: ResolveConsumerNodeInput): ConsumerNode {
  const { repoRoot, defaultVersion, configPath = '.dev-agent.yml' } = input;
  const override = fromDevAgentConfig(repoRoot, configPath);
  if (override !== null) return { version: override, source: `${configPath} runtime.node` };
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
  const configPath = process.env.CONFIG_PATH || '.dev-agent.yml';
  const resolved = resolveConsumerNode({ repoRoot, defaultVersion, configPath });
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
