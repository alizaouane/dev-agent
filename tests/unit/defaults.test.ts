import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { devAgentConfigSchema } from '../../lib/schema';

describe('schema/defaults.yml', () => {
  it('loads as valid YAML', () => {
    const content = readFileSync(resolve(__dirname, '../../schema/defaults.yml'), 'utf8');
    const parsed = yaml.load(content);
    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe('object');
  });

  it('passes the full devAgentConfigSchema (defaults are themselves a complete config)', () => {
    const content = readFileSync(resolve(__dirname, '../../schema/defaults.yml'), 'utf8');
    const parsed = yaml.load(content);
    const result = devAgentConfigSchema.safeParse(parsed);
    if (!result.success) {
      console.error('Validation errors:', JSON.stringify(result.error.format(), null, 2));
    }
    expect(result.success).toBe(true);
  });
});
