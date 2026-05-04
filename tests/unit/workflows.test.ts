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
  'phase-bug-scout.yml',
];

// Workflows that take an `issue_number` input. phase-bug-scout doesn't —
// it operates on the whole repo, not a specific issue.
const ISSUE_NUMBER_WORKFLOWS = PHASE_WORKFLOWS.filter((w) => w !== 'phase-bug-scout.yml');

const ALL_REUSABLE = [...PHASE_WORKFLOWS, 'orch-sweep.yml'];

// Event-triggered workflows that listen to GitHub events (not reusable
// via workflow_call). They share the YAML / security invariants but
// don't need to declare workflow_call inputs.
const EVENT_TRIGGERED_WORKFLOWS = ['phase-pr-review.yml'];

describe('.github/workflows/', () => {
  for (const wf of [...ALL_REUSABLE, ...EVENT_TRIGGERED_WORKFLOWS, 'ci.yml']) {
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
    for (const wf of ISSUE_NUMBER_WORKFLOWS) {
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
    for (const wf of [...ALL_REUSABLE, ...EVENT_TRIGGERED_WORKFLOWS, 'ci.yml']) {
      const raw = readFileSync(resolve(workflowsDir, wf), 'utf8');
      const runBlocks = raw.split(/\n\s+run:\s*\|/).slice(1);
      for (const block of runBlocks) {
        const upToNextStep = block.split(/\n\s+- (?:name|uses|run|id):/)[0];
        expect(upToNextStep).not.toMatch(forbidden);
      }
    }
  });

  describe('phase-pr-review.yml', () => {
    const raw = readFileSync(resolve(workflowsDir, 'phase-pr-review.yml'), 'utf8');
    const parsed = yaml.load(raw) as {
      on?: Record<string, unknown>;
      jobs?: Record<string, { if?: string; permissions?: Record<string, string> }>;
    };

    it('listens to comment + review events', () => {
      expect(parsed.on?.issue_comment).toBeDefined();
      expect(parsed.on?.pull_request_review).toBeDefined();
      expect(parsed.on?.pull_request_review_comment).toBeDefined();
    });

    it('gates the job behind a @claude mention check', () => {
      const job = parsed.jobs?.['pr-review'];
      expect(job?.if).toMatch(/@claude/);
    });

    it('excludes claude[bot] comments to avoid loops', () => {
      const job = parsed.jobs?.['pr-review'];
      expect(job?.if).toMatch(/claude\[bot\]/);
    });

    it('grants id-token: write for OIDC', () => {
      const job = parsed.jobs?.['pr-review'];
      expect(job?.permissions?.['id-token']).toBe('write');
    });

    it('validates head ref shape with a regex before checkout', () => {
      // The Resolve PR head branch step must whitelist the head ref to a
      // strict feat/dev-agent-issue-<digits> shape; otherwise an attacker
      // who can push a PR could choose a head ref that smuggles shell
      // metacharacters into the checkout step.
      expect(raw).toMatch(/feat\/dev-agent-issue-\[0-9\]\+\$/);
    });
  });
});
