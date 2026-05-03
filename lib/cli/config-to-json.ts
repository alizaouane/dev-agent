#!/usr/bin/env tsx
/**
 * Read the .dev-agent.yml at the path given by argv[2] (or env CONFIG_PATH)
 * and emit it as JSON on stdout. Lets workflow steps use jq on the result
 * without having to know YAML — every YAML→JSON conversion lives here.
 *
 * Usage:
 *   npx tsx lib/cli/config-to-json.ts examples/test-repo/.dev-agent.yml
 *   CONFIG_PATH=examples/test-repo/.dev-agent.yml npx tsx lib/cli/config-to-json.ts
 */
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

function main(): void {
  const path = process.argv[2] ?? process.env.CONFIG_PATH;
  if (!path) {
    console.error('usage: config-to-json.ts <path-to-.dev-agent.yml>');
    process.exit(2);
  }
  const raw = readFileSync(path, 'utf8');
  const parsed = yaml.load(raw);
  process.stdout.write(JSON.stringify(parsed));
}

main();
