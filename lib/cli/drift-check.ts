#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyChangedFiles } from '../drift-check';
import { parseConfig } from '../parse-config';

const SPEC_PATH = process.env.SPEC_PATH ?? '';
const BASE = process.env.BASE_REF ?? 'main';
const HEAD = process.env.HEAD_REF ?? 'HEAD';
const CONFIG_PATH = process.env.CONFIG_PATH ?? '.dev-agent.yml';

const defaultsPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'schema',
  'defaults.yml',
);

function declaredScopeFromSpec(specText: string): string[] {
  const m = specText.match(/##\s+(Critical files|Files modified)\s+([\s\S]*?)(?=\n##\s+|$)/i);
  if (!m) return [];
  return Array.from(m[2].matchAll(/^-\s+`?([^\s`]+)`?/gm)).map((mm) => mm[1]);
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' });
}

async function main(): Promise<void> {
  if (!SPEC_PATH) throw new Error('SPEC_PATH required');
  const config = await parseConfig({ configPath: CONFIG_PATH, defaultsPath });
  const specText = readFileSync(SPEC_PATH, 'utf8');
  const declared_scope = declaredScopeFromSpec(specText);

  const range = `${BASE}...${HEAD}`;
  const diffNames = git('diff', '--name-only', range).split('\n').filter(Boolean);
  const diffStat = git('diff', '--numstat', range);
  const added_lines: Record<string, number> = {};
  for (const line of diffStat.split('\n').filter(Boolean)) {
    const [add, _del, file] = line.split('\t');
    added_lines[file] = parseInt(add, 10) || 0;
  }
  const result = classifyChangedFiles({
    changed_files: diffNames,
    declared_scope,
    trivial_categories: config.guardrails.trivial_cleanup_categories,
    trivial_classifier: () => false,
    thresholds: config.guardrails.scope_creep_thresholds,
    added_lines,
  });
  console.log(JSON.stringify(result));
  if (result.verdict === 'scope_creep') process.exit(1);
}

main().catch((err) => {
  console.error(`drift-check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
