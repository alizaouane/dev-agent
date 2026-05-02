import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const manifestPath = resolve(__dirname, '../../.claude-plugin/plugin.json');

describe('.claude-plugin/plugin.json', () => {
  const raw = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw) as Record<string, unknown>;

  it('parses as JSON', () => {
    expect(manifest).toBeDefined();
    expect(typeof manifest).toBe('object');
  });

  it('has name "dev-agent"', () => {
    expect(manifest.name).toBe('dev-agent');
  });

  it('has a semver-shaped version', () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });

  it('declares commands and skills paths', () => {
    expect(manifest.commands).toBe('./commands/');
    expect(manifest.skills).toBe('./skills/');
  });

  it('has a non-empty description', () => {
    expect(typeof manifest.description).toBe('string');
    expect((manifest.description as string).length).toBeGreaterThan(20);
  });

  it('manifest version matches package.json version', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, '../../package.json'), 'utf8'),
    ) as { version: string };
    expect(manifest.version).toBe(pkg.version);
  });
});
