import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { devAgentConfigSchema } from '../../lib/schema';

const labelVocabularySchema = z.object({
  states: z.array(z.string().regex(/^state:[a-z-]+$/)).nonempty(),
  kinds: z.array(z.string().regex(/^kind:[a-z-]+$/)).nonempty(),
  priorities: z.array(z.string().regex(/^priority:p[0-3]$/)).length(4),
});

describe('schema/label-vocabulary.yml', () => {
  it('loads and matches expected shape', () => {
    const content = readFileSync(resolve(__dirname, '../../schema/label-vocabulary.yml'), 'utf8');
    const parsed = yaml.load(content);
    const result = labelVocabularySchema.safeParse(parsed);
    if (!result.success) console.error(result.error.format());
    expect(result.success).toBe(true);
  });

  it('contains all 12 canonical states from the spec', () => {
    const content = readFileSync(resolve(__dirname, '../../schema/label-vocabulary.yml'), 'utf8');
    const parsed = yaml.load(content) as { states: string[] };
    expect(parsed.states).toEqual(
      expect.arrayContaining([
        'state:proposed',
        'state:scoping',
        'state:spec-ready',
        'state:implementing',
        'state:pr-review',
        'state:staging-deployed',
        'state:ready-to-promote',
        'state:promoting',
        'state:done',
        'state:blocked',
        'state:abandoned',
        'state:rolled-back',
      ])
    );
  });

  it('contains all 4 canonical kinds', () => {
    const content = readFileSync(resolve(__dirname, '../../schema/label-vocabulary.yml'), 'utf8');
    const parsed = yaml.load(content) as { kinds: string[] };
    expect(parsed.kinds).toEqual(
      expect.arrayContaining(['kind:user-intent', 'kind:scout-proposal', 'kind:scout-digest', 'kind:hotfix'])
    );
  });
});

describe('schema/dev-agent.schema.yml', () => {
  it('loads as YAML', () => {
    const content = readFileSync(resolve(__dirname, '../../schema/dev-agent.schema.yml'), 'utf8');
    const parsed = yaml.load(content) as Record<string, unknown>;
    expect(parsed).toBeDefined();
    expect(parsed.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(parsed.title).toBe('.dev-agent.yml');
  });
});

describe('examples/test-repo/.dev-agent.yml', () => {
  it('parses against devAgentConfigSchema', () => {
    const content = readFileSync(
      resolve(__dirname, '../../examples/test-repo/.dev-agent.yml'),
      'utf8'
    );
    const parsed = yaml.load(content);
    const result = devAgentConfigSchema.safeParse(parsed);
    if (!result.success) console.error(result.error.format());
    expect(result.success).toBe(true);
  });
});
