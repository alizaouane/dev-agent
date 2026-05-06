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
  'phase-unfinished-work-scout.yml',
  'phase-cleanup-scout.yml',
];

// Workflows that take an `issue_number` input. The scout workflows
// don't — they operate on the whole repo, not a specific issue.
const ISSUE_NUMBER_WORKFLOWS = PHASE_WORKFLOWS.filter(
  (w) =>
    w !== 'phase-bug-scout.yml' &&
    w !== 'phase-unfinished-work-scout.yml' &&
    w !== 'phase-cleanup-scout.yml',
);

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

  describe('phase-implement.yml — agent-no-pr salvage', () => {
    const raw = readFileSync(resolve(workflowsDir, 'phase-implement.yml'), 'utf8');

    it('has a Salvage step that runs after Run Claude Code', () => {
      // Regression: agent ran 150 turns on issue #146, edited code,
      // then ended its turn without committing or pushing. The branch
      // existed only on the runner's filesystem and was lost. The
      // salvage step finalizes uncommitted work + pushes + opens PR.
      expect(raw).toMatch(/Salvage agent's work/);
      // Must run only on live mode + only when prior steps succeeded.
      expect(raw).toMatch(/inputs\.invocation_mode == 'live' && success\(\)/);
    });

    it('salvage step detects ALL three change types — staged, unstaged, AND untracked', () => {
      // Regression: the prior `git diff --quiet || ! git diff --cached --quiet`
      // missed untracked-only changes — the most common "agent
      // stopped before commit" pattern (mkdir + write a new file,
      // never `git add`). `git status --porcelain` covers all three
      // (staged, unstaged, untracked) in one go, so the salvage
      // path catches the dominant failure case.
      expect(raw).toMatch(/git status --porcelain/);
      // Negative: ensure the old diff-only guard hasn't crept back.
      expect(raw).not.toMatch(/git diff --quiet \|\| ! git diff --cached --quiet/);
      expect(raw).toMatch(/dev-agent\[bot\]/);
      expect(raw).toMatch(/workflow-finalized/);
    });

    it('reserves workflow artifacts in .git/info/exclude before any agent activity', () => {
      // Regression: `git add -A` in the salvage step would sweep
      // workflow-generated files like issue.json (written by the
      // Read issue step) and .dev-agent-engine/ (the nested engine
      // checkout) into the salvage commit, polluting the consumer's
      // PR with a gitlink/submodule entry and stale issue metadata.
      // The "Reserve workflow artifacts" step adds these to
      // .git/info/exclude (per-clone, no consumer .gitignore mod)
      // so all downstream git operations skip them.
      expect(raw).toMatch(/Reserve workflow artifacts from agent git state/);
      expect(raw).toMatch(/\.git\/info\/exclude/);
      // Both of the known workflow artifacts must be in the exclude list.
      expect(raw).toMatch(/['"]issue\.json['"]/);
      expect(raw).toMatch(/['"]\.dev-agent-engine\/['"]/);
    });

    it('salvage step pushes the branch and opens a PR if missing', () => {
      expect(raw).toMatch(/git push -u origin "\$BRANCH_NAME"/);
      expect(raw).toMatch(/gh pr create/);
      // Idempotent: only opens PR when one isn't already there.
      expect(raw).toMatch(/gh pr view "\$BRANCH_NAME"/);
    });

    it('salvage step warns on issue when PR creation 403s', () => {
      // The "Allow GitHub Actions to create and approve pull requests"
      // setting is per-repo and not always on; if pr create fails,
      // the operator needs a clear hint, not just a silent no-op.
      expect(raw).toMatch(/Allow GitHub Actions to create and approve pull requests/);
    });
  });

  describe('phase-implement.yml — Read issue spec-path detection', () => {
    const raw = readFileSync(resolve(workflowsDir, 'phase-implement.yml'), 'utf8');

    it('falls back to any docs/**/*.md ref when the SPECS_DIR-prefixed grep misses', () => {
      // Regression: the original regex only matched docs/specs/*.md
      // (the configured SPECS_DIR), so issues whose body referenced
      // e.g. docs/superpowers/specs/foo.md fell through to the
      // placeholder spec — leaving the agent to work from goal blurbs
      // instead of the real spec.
      // Both grep patterns must be present: the SPECS_DIR-scoped one
      // (canonical) and the broader docs/ one (fallback).
      expect(raw).toMatch(/grep -oE "\$\{SPECS_DIR\}/);
      expect(raw).toMatch(/grep -oE "docs\//);
    });
  });
});
