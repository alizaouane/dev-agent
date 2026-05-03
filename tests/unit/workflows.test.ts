import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

const workflowsDir = resolve(__dirname, '../../.github/workflows');

const PHASE_WORKFLOWS = [
  'phase-implement.yml',
  'phase-staging-deploy.yml',
  'phase-promote-to-prod.yml',
  'phase-smoke-verify.yml',
  'phase-rollback.yml',
];

const ALL_REUSABLE = [...PHASE_WORKFLOWS, 'orch-sweep.yml'];

describe('.github/workflows/', () => {
  for (const wf of [...ALL_REUSABLE, 'ci.yml']) {
    describe(wf, () => {
      const path = resolve(workflowsDir, wf);
      const raw = readFileSync(path, 'utf8');
      const parsed = yaml.load(raw) as Record<string, unknown>;

      it('parses as YAML', () => {
        expect(parsed).toBeDefined();
        expect(typeof parsed).toBe('object');
      });

      it('has a name', () => {
        expect(typeof parsed.name).toBe('string');
      });

      it('has at least one job', () => {
        expect(parsed.jobs).toBeDefined();
        expect(Object.keys(parsed.jobs as object).length).toBeGreaterThan(0);
      });
    });
  }

  describe('reusable phase workflows', () => {
    for (const wf of PHASE_WORKFLOWS) {
      it(`${wf} declares workflow_call with issue_number input`, () => {
        const raw = readFileSync(resolve(workflowsDir, wf), 'utf8');
        const parsed = yaml.load(raw) as { on?: { workflow_call?: { inputs?: Record<string, unknown> } } };
        expect(parsed.on?.workflow_call).toBeDefined();
        expect(parsed.on?.workflow_call?.inputs?.issue_number).toBeDefined();
      });
    }
  });

  it('no run: block inlines github.event.* (title|body) directly', () => {
    const forbidden = /\$\{\{\s*github\.event\.[a-z_.]*(title|body)/i;
    for (const wf of [...ALL_REUSABLE, 'ci.yml']) {
      const raw = readFileSync(resolve(workflowsDir, wf), 'utf8');
      const runBlocks = raw.split(/\n\s+run:\s*\|/).slice(1);
      for (const block of runBlocks) {
        const upToNextStep = block.split(/\n\s+- (?:name|uses|run|id):/)[0];
        expect(upToNextStep).not.toMatch(forbidden);
      }
    }
  });
});
