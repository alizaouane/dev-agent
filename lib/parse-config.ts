import { readFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';
import deepmerge from 'deepmerge';
import { devAgentConfigSchema, type DevAgentConfigParsed } from './schema.js';

export interface ParseConfigOptions {
  configPath: string;
  defaultsPath: string;
}

export async function parseConfig(opts: ParseConfigOptions): Promise<DevAgentConfigParsed> {
  if (!existsSync(opts.configPath)) {
    throw new Error(`ENOENT: config not found at ${opts.configPath}`);
  }
  if (!existsSync(opts.defaultsPath)) {
    throw new Error(`ENOENT: defaults not found at ${opts.defaultsPath}`);
  }

  const defaultsRaw = yaml.load(readFileSync(opts.defaultsPath, 'utf8')) as Record<string, unknown>;
  const userRaw = yaml.load(readFileSync(opts.configPath, 'utf8')) as Record<string, unknown>;

  // deepmerge handles nested objects; arrays in user config OVERRIDE defaults arrays
  // (we don't want default blocked_paths leaking into a project that omitted them).
  const arrayMerge = (_target: unknown[], source: unknown[]) => source;
  const merged = deepmerge(defaultsRaw, userRaw, { arrayMerge });

  const result = devAgentConfigSchema.safeParse(merged);
  if (!result.success) {
    const formatted = JSON.stringify(result.error.format(), null, 2);
    throw new Error(`Config validation failed for ${opts.configPath}:\n${formatted}`);
  }
  return result.data;
}
