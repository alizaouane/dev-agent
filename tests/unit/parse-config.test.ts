import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { parseConfig } from '../../lib/parse-config';

const SAMPLE_CONFIG = resolve(__dirname, '../../examples/test-repo/.dev-agent.yml');
const DEFAULTS = resolve(__dirname, '../../schema/defaults.yml');

describe('parseConfig', () => {
  it('loads + validates the sample test-repo config', async () => {
    const config = await parseConfig({ configPath: SAMPLE_CONFIG, defaultsPath: DEFAULTS });
    expect(config.schema_version).toBe(1);
    expect(config.commands.test).toBe("echo 'mock test'");
    expect(config.branches.staging).toBeNull();
  });

  it('throws when given a path that does not exist', async () => {
    await expect(
      parseConfig({ configPath: '/nonexistent/.dev-agent.yml', defaultsPath: DEFAULTS })
    ).rejects.toThrow(/ENOENT|not found/i);
  });

  it('throws on invalid config', async () => {
    // We synthesize an invalid config in-memory by passing a JSON string path trick:
    // for this test we'll write a tmp file.
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(`${tmpdir()}/dev-agent-test-`);
    const badPath = `${dir}/.dev-agent.yml`;
    writeFileSync(badPath, 'schema_version: 999\n');
    await expect(parseConfig({ configPath: badPath, defaultsPath: DEFAULTS })).rejects.toThrow(/schema_version|validation/i);
  });

  it('merges defaults — partial config still validates', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(`${tmpdir()}/dev-agent-test-`);
    const partialPath = `${dir}/.dev-agent.yml`;
    writeFileSync(partialPath, `
schema_version: 1
commands:
  test: "vitest run"
  build: "vite build"
  typecheck: "tsc --noEmit"
`);
    const config = await parseConfig({ configPath: partialPath, defaultsPath: DEFAULTS });
    expect(config.commands.test).toBe('vitest run');
    expect(config.guardrails.max_files_changed).toBe(30); // came from defaults
  });
});
