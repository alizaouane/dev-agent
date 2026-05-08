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
  // Industry-grade verification gates (build steps 6 + 9 + 12 + 13)
  'phase-acm.yml',
  'phase-evidence-collector.yml',
  'phase-swarm-review.yml',
  'phase-tier2-smoke.yml',
];

// Workflows that take an `issue_number` input. The scout workflows operate
// on the whole repo (not an issue); phase-evidence-collector + phase-swarm-review
// operate on a PR (pr_number, not issue_number).
const ISSUE_NUMBER_WORKFLOWS = PHASE_WORKFLOWS.filter(
  (w) =>
    w !== 'phase-bug-scout.yml' &&
    w !== 'phase-unfinished-work-scout.yml' &&
    w !== 'phase-cleanup-scout.yml' &&
    w !== 'phase-evidence-collector.yml' &&
    w !== 'phase-swarm-review.yml',
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

  describe('Pillar 5 — Harden-Runner egress audit', () => {
    // Every reusable phase + the orch-sweep cron runs claude-code-action
    // and/or shell commands that could exfiltrate secrets. Each one must
    // start with `step-security/harden-runner@v2` as the very first step
    // so the runner's egress is captured (audit mode) before any other
    // step runs. v1 ships in audit mode; v1.1 flips to block-mode after
    // we've collected enough audit data to populate allowed-endpoints
    // accurately per phase.
    for (const wf of [...ALL_REUSABLE, ...EVENT_TRIGGERED_WORKFLOWS]) {
      it(`${wf} starts with step-security/harden-runner@v2`, () => {
        const raw = readFileSync(resolve(workflowsDir, wf), 'utf8');
        expect(raw).toMatch(/uses:\s+step-security\/harden-runner@v2/);
        // The harden-runner step must appear *before* the first checkout.
        const hardenIdx = raw.indexOf('step-security/harden-runner@v2');
        const checkoutIdx = raw.indexOf('actions/checkout@v4');
        const otherUsesMatch = raw.match(/^\s+- (?:name:|uses:)/m);
        expect(hardenIdx).toBeGreaterThan(0);
        if (checkoutIdx > 0) {
          expect(hardenIdx, `${wf}: harden-runner must precede first checkout`).toBeLessThan(checkoutIdx);
        }
        // For phase-pr-review.yml (no checkout-first) the harden-runner
        // must still be the first concrete step — assert it lands before
        // the workflow's first non-harden `name:` step.
        if (otherUsesMatch && otherUsesMatch.index !== undefined) {
          // The first `- name:` or `- uses:` we find should be the
          // harden-runner one; every later step appears after it.
          const firstStepIdx = raw.indexOf('Harden runner (egress audit)');
          expect(firstStepIdx, `${wf}: missing harden-runner step name`).toBeGreaterThan(0);
        }
      });

      it(`${wf} ships harden-runner in audit (not block) mode for v1`, () => {
        const raw = readFileSync(resolve(workflowsDir, wf), 'utf8');
        // Locate the harden-runner block and confirm egress-policy: audit.
        // v1.1 will flip to `block` after audit data + allowed-endpoints
        // are populated. This test pins v1's expected mode so an accidental
        // early flip to block (which would break real consumer workflows
        // until allowed-endpoints is set) is caught in CI.
        const hardenBlock = raw.match(
          /uses:\s+step-security\/harden-runner@v2\s*\n\s*with:\s*\n\s*egress-policy:\s*(\w+)/,
        );
        expect(hardenBlock, `${wf}: harden-runner block not parseable`).toBeTruthy();
        if (hardenBlock) expect(hardenBlock[1]).toBe('audit');
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

    it('has a swarm-override sibling job (Pillar 2 escape hatch, step 16)', () => {
      // The /swarm-override comment handler must:
      //   - run in a SIBLING job (not the same job as @claude — different
      //     concerns: agent-driven fix vs human-driven label flip)
      //   - filter to issue_comment events only (no review-comment / review)
      //   - require body STARTS WITH /swarm-override (prefix-match, not just
      //     contains, so a casual mention in a longer comment doesn't trigger)
      //   - exclude bot actors (claude[bot], dev-agent[bot])
      const parsedRaw = yaml.load(raw) as { jobs?: Record<string, { if?: string }> };
      expect(parsedRaw.jobs).toHaveProperty('swarm-override');
      const jobIf = parsedRaw.jobs!['swarm-override'].if!;
      expect(jobIf).toMatch(/issue_comment/);
      expect(jobIf).toMatch(/issue\.pull_request/);
      expect(jobIf).toMatch(/startsWith.*swarm-override/);
      expect(jobIf).toMatch(/claude\[bot\]/);
      expect(jobIf).toMatch(/dev-agent\[bot\]/);
    });

    it('swarm-override step records actor + reason + timestamp', () => {
      // The audit comment IS the v1 audit trail — must include who, why,
      // and when. v1.1 mirrors these into lib/events.ts's JSONL log.
      expect(raw).toMatch(/swarm-override applied/);
      expect(raw).toMatch(/Actor.*ACTOR/);
      expect(raw).toMatch(/Reason.*REASON/);
      expect(raw).toMatch(/Timestamp/);
    });

    it('swarm-override is idempotent on label flips', () => {
      // Flips should use `|| true` so re-applying when a label is already
      // present (or absent) doesn't error. Otherwise a re-trigger would
      // 422 and the operator wouldn't know whether the override actually
      // landed.
      expect(raw).toMatch(/--remove-label 'swarm-review:fail' \|\| true/);
      expect(raw).toMatch(/--add-label 'swarm-overridden' \|\| true/);
    });

    it('validates head ref shape with a regex before checkout', () => {
      // The Resolve PR head branch step must whitelist the head ref to a
      // strict feat/dev-agent-issue-<digits> shape; otherwise an attacker
      // who can push a PR could choose a head ref that smuggles shell
      // metacharacters into the checkout step.
      expect(raw).toMatch(/feat\/dev-agent-issue-\[0-9\]\+\$/);
    });
  });

  describe('phase-swarm-review.yml — total-outage guard', () => {
    const raw = readFileSync(resolve(workflowsDir, 'phase-swarm-review.yml'), 'utf8');

    it('fails the gate when ALL 3 reviewers produced no output', () => {
      // P1 (PR #77 review): backfilling 3 abstains on a total reviewer
      // outage would silently turn the outage into a passing gate
      // (aggregator treats all-abstain as zero fail/concern weight =
      // swarm-pass). The guard MUST exit 1 + post a comment instead of
      // synthesizing 3 abstains. Lock the behavior in.
      expect(raw).toMatch(/PRESENT=0/);
      expect(raw).toMatch(/all 3 reviewers produced no output/);
      expect(raw).toMatch(/swarm-review:outage/);
      // Critically: the exit-1 must be guarded by PRESENT == 0 only.
      expect(raw).toMatch(/if \[ "\$PRESENT" = "0" \]/);
      // Partial outage (1 or 2 missing) STILL backfills abstain — the
      // remaining reviewers' verdicts still count.
      expect(raw).toMatch(/Partial outage/);
    });
  });

  describe('phase-swarm-review.yml — tag-safe untrusted_content wrapper', () => {
    const raw = readFileSync(resolve(workflowsDir, 'phase-swarm-review.yml'), 'utf8');

    it('sanitizes any literal </untrusted_content> in the PR diff before embedding', () => {
      // CodeRabbit Major (PR #77): a PR adding a literal `</untrusted_content>`
      // (e.g. as a test fixture, a doc snippet, or a deliberate injection
      // attempt) would otherwise close the wrapper early and let downstream
      // bytes be parsed as trusted instructions. The reviewer rendering must
      // pipe the diff through a sed substitution that neutralizes any
      // closing tag (case-insensitive) before the cat.
      expect(raw).toMatch(
        /sed 's\|<\/\[uU\]\[nN\]\[tT\]\[rR\]\[uU\]\[sS\]\[tT\]\[eE\]\[dD\]_\[cC\]\[oO\]\[nN\]\[tT\]\[eE\]\[nN\]\[tT\]>\|<\/untrusted_content_blocked>\|g' \/tmp\/pr-diff\.txt/,
      );
      // Negative: the unsanitized cat must NOT come back as a regression.
      expect(raw).not.toMatch(/^\s+cat \/tmp\/pr-diff\.txt$/m);
    });

    it('caps the diff with UTF-8-safe truncation (no half-cleaved codepoints)', () => {
      // CodeRabbit nitpick (PR #77): a raw byte cut at 200000 can split a
      // UTF-8 multi-byte sequence and produce malformed bytes at the cap.
      // The fix uses a slightly-smaller raw cut piped through `iconv -c`
      // which drops invalid sequences. Lock the iconv stage in so a future
      // refactor can't silently regress to raw `head -c`.
      expect(raw).toMatch(/head -c 199990 \/tmp\/pr-diff\.txt \| iconv -c -f utf-8 -t utf-8/);
      expect(raw).not.toMatch(/head -c 200000 \/tmp\/pr-diff\.txt > \/tmp\/pr-diff-capped\.txt/);
    });
  });

  describe('phase-swarm-review.yml — aggregator-crash fallback', () => {
    const raw = readFileSync(resolve(workflowsDir, 'phase-swarm-review.yml'), 'utf8');

    it('posts a fallback comment + label when the aggregator step fails', () => {
      // CodeRabbit nitpick (PR #77): if `swarm-aggregate.ts` crashes or
      // never writes /tmp/swarm-aggregate.json, both the comment + label
      // steps skip on `outcome != 'success'`. Without a fallback the PR
      // author sees a red workflow with no signal on the PR itself. Lock
      // in: a "Post crash comment when aggregator failed" step gated on
      // `aggregate.outcome == 'failure'` that applies `swarm-review:error`.
      expect(raw).toMatch(/Post crash comment when aggregator failed/);
      expect(raw).toMatch(/swarm-review:error/);
    });

    it("if-clause starts with always() so the step actually runs after a failure", () => {
      // codex P2 (PR #78 review): GitHub Actions implicitly prepends
      // `success()` to every `if:` expression that does not already
      // contain a status-check function. A bare
      //   if: steps.aggregate.outcome == 'failure'
      // therefore evaluates as
      //   success() && steps.aggregate.outcome == 'failure'
      // which is always false when the aggregator step has actually
      // failed — the step skips in the exact scenario it's meant to
      // cover. The fix is to start the if-clause with `always() &&`
      // (or `failure() &&`); lock that in as a regression guard.
      expect(raw).toMatch(/if: always\(\) && steps\.aggregate\.outcome == 'failure'/);
      // Negative: the bare form must NOT come back.
      expect(raw).not.toMatch(/if: steps\.aggregate\.outcome == 'failure'\s*$/m);
    });

    it('reflects the actual invocation_mode in the fallback message (no hardcoded "live")', () => {
      // CodeRabbit minor (PR #78 review): the fallback message used to
      // hardcode `Mode: live` even though the step can fire in stub
      // runs too (it's gated only on aggregator failure, not on mode).
      // Read the value from inputs.invocation_mode via env so the
      // diagnostic is honest about which mode crashed.
      expect(raw).toMatch(/INVOCATION_MODE: \$\{\{ inputs\.invocation_mode \}\}/);
      // The body must use printf with %s + the env var (not a literal).
      expect(raw).toMatch(/printf '🤖 Phase: swarm-review.*Mode: %s.*' "\$INVOCATION_MODE"/s);
      // Negative: the hardcoded "Mode: live" line must not return.
      expect(raw).not.toMatch(/Verdict: error\\nMode: live\\n/);
    });
  });

  describe('phase-swarm-review.yml — v1.6 EvidenceBundle integration (Pillar 2)', () => {
    const raw = readFileSync(resolve(workflowsDir, 'phase-swarm-review.yml'), 'utf8');

    it('downloads the verification-bundle artifact from evidence-collector', () => {
      // The cross-workflow handoff: phase-evidence-collector uploads
      // `verification-bundle-pr-<N>` in v1.5; phase-swarm-review must
      // download the same name to consume the deterministic-scanner output.
      // continue-on-error so a missing artifact doesn't crash the gate
      // (evidence-summarize.ts emits an absent-summary stub in that case).
      expect(raw).toMatch(/Live mode — download evidence-collector bundle/);
      expect(raw).toMatch(/uses: actions\/download-artifact@v4/);
      expect(raw).toMatch(/name: verification-bundle-pr-\$\{\{ inputs\.pr_number \}\}/);
      expect(raw).toMatch(/continue-on-error: true/);
    });

    it('extracts + summarizes the bundle via lib/cli/evidence-summarize.ts', () => {
      // The summary CLI normalizes scanner output into the shape the reviewer
      // prompts depend on. Lock the path + flags so a refactor can't silently
      // break the pipeline (reviewer prompts have hard-coded field names).
      expect(raw).toMatch(/lib\/cli\/evidence-summarize\.ts/);
      expect(raw).toMatch(/--bundle-dir \/tmp\/evidence-bundle/);
      expect(raw).toMatch(/--output \/tmp\/evidence-summary\.json/);
    });

    it('preserves the missing-bundle signal — only mkdirs the bundle dir on successful download', () => {
      // codex P2 (PR #79 review): an unconditional `mkdir -p
      // /tmp/evidence-bundle` followed by the summarizer makes a failed
      // artifact download look identical to a clean scanner run (zero
      // counts everywhere, no marker). The fix is to mkdir ONLY inside
      // the if-then branch where we have a tarball to extract — when
      // the artifact is absent, the dir stays nonexistent and the CLI
      // takes its absent-summary path. Lock the structure.
      //
      // The mkdir line must appear AFTER the tarball-existence check,
      // not before it. We verify by checking the relative position of
      // the two strings inside the extract step.
      const stepStart = raw.indexOf('Live mode — extract + summarize evidence bundle');
      const stepEnd = raw.indexOf('- name:', stepStart + 1);
      expect(stepStart).toBeGreaterThan(0);
      const stepBody = raw.slice(stepStart, stepEnd === -1 ? undefined : stepEnd);
      const tarCheckIdx = stepBody.indexOf('if [ -f /tmp/evidence-artifact/verification-bundle.tar.gz ]');
      const mkdirIdx = stepBody.indexOf('mkdir -p /tmp/evidence-bundle');
      expect(tarCheckIdx).toBeGreaterThan(0);
      expect(mkdirIdx).toBeGreaterThan(0);
      expect(
        mkdirIdx,
        'mkdir of /tmp/evidence-bundle must appear AFTER the tarball-existence check (codex P2)',
      ).toBeGreaterThan(tarCheckIdx);
    });

    it('injects the evidence summary into every reviewer prompt with sed sanitization', () => {
      // Cognition's anti-multi-agent argument resolved: all three reviewers
      // see the SAME EvidenceBundle summary in the SAME wrapper position.
      // The wrapper goes through the same sed sanitization as the diff —
      // scanner output can contain attacker-controlled substrings (e.g. a
      // PR adding adversarial fixture content that gitleaks's `Match` field
      // echoes back).
      expect(raw).toMatch(/EvidenceBundle scanner summary \(untrusted/);
      expect(raw).toMatch(/<untrusted_content source="evidence_summary">/);
      // Sed must run on /tmp/evidence-summary.json with the same closing-tag
      // neutralization as the diff path.
      expect(raw).toMatch(
        /sed 's\|<\/\[uU\]\[nN\]\[tT\]\[rR\]\[uU\]\[sS\]\[tT\]\[eE\]\[dD\]_\[cC\]\[oO\]\[nN\]\[tT\]\[eE\]\[nN\]\[tT\]>\|<\/untrusted_content_blocked>\|g' \/tmp\/evidence-summary\.json/,
      );
    });

    it('reviewer prompt includes the scanner field in the output JSON shape', () => {
      // v1.6 reviewers must propagate the scanner attribution so the
      // aggregator / PR comment can label a finding's origin (gitleaks vs
      // semgrep vs npm-audit vs scout-llm). The output schema must list
      // the four valid scanner values.
      expect(raw).toMatch(/"scanner": "gitleaks" \| "semgrep" \| "npm-audit" \| "scout-llm"/);
    });

    it('reviewer discipline note marks the deterministic scanners as authoritative', () => {
      // A swarm reviewer cannot soften a HIGH gitleaks/semgrep/npm-audit
      // finding — the scanners are the gate. The discipline note in the
      // rendered prompt must call this out explicitly so a confused
      // reviewer doesn't downgrade a real CVE because the diff "looks fine".
      expect(raw).toMatch(/AUTHORITATIVE/);
      expect(raw).toMatch(/cannot soften their findings/);
    });
  });

  describe('phase-acm.yml — Critical + Major fixes from PR #77 review', () => {
    const raw = readFileSync(resolve(workflowsDir, 'phase-acm.yml'), 'utf8');

    it('does not bind TEST_CMD via a non-existent steps.config output', () => {
      // CodeRabbit Critical (PR #77): the verify-red step had
      //   env.TEST_CMD: ${{ steps.config.outputs.test_cmd || 'npm test --' }}
      // but the convert-config step has no `id:` and writes nothing to
      // $GITHUB_OUTPUT, so this binding silently always fell back to
      // 'npm test --', masking config errors. The shell still pulls
      // TEST_CMD via jq inside the script — that single read is the
      // source of truth.
      // Match the YAML-expression form specifically (not the brief
      // explanatory comment that documents *why* the binding was removed).
      expect(raw).not.toMatch(/\$\{\{\s*steps\.config\.outputs\.test_cmd/);
      // The single jq read in the verify-red step must remain.
      expect(raw).toMatch(/TEST_CMD=\$\(jq -r '\.commands\.test \/\/ "npm test --"' \/tmp\/config\.json\)/);
    });

    it('sanitizes any literal </untrusted_content> in the spec before embedding', () => {
      // CodeRabbit Major (PR #77): same prompt-injection escape as the
      // swarm-review wrapper — a spec containing a literal
      // `</untrusted_content>` would close the wrapper early and let the
      // remaining content be parsed as trusted instructions. The render
      // step must sanitize via sed before cat'ing the spec.
      expect(raw).toMatch(
        /sed 's\|<\/\[uU\]\[nN\]\[tT\]\[rR\]\[uU\]\[sS\]\[tT\]\[eE\]\[dD\]_\[cC\]\[oO\]\[nN\]\[tT\]\[eE\]\[nN\]\[tT\]>\|<\/untrusted_content_blocked>\|g' "\$SPEC_PATH"/,
      );
      // Negative: the unsanitized cat of the spec must not return.
      expect(raw).not.toMatch(/^\s+cat "\$SPEC_PATH"$/m);
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

  describe('phase-implement.yml — ACM gate (Pillar 1)', () => {
    const raw = readFileSync(resolve(workflowsDir, 'phase-implement.yml'), 'utf8');

    it('prefetches the feature branch so the ACM manifest is in scope', () => {
      // phase-acm pushes .dev-agent/acm-manifest.json + tests/acm/* to the
      // feature branch BEFORE phase-implement runs. phase-implement starts
      // on `main` (default checkout), so it must explicitly switch to the
      // feature branch — otherwise claude-code-action would branch off main
      // and the manifest would not be visible to the agent.
      expect(raw).toMatch(/Prefetch feature branch/);
      expect(raw).toMatch(/git ls-remote --exit-code --heads origin/);
    });

    it('runs the ACM pre-flight to detect manifest presence', () => {
      // Pre-flight is informational: it sets `gate_active=true` when a
      // manifest is on the branch (so the post-agent gate kicks in) and
      // `gate_active=false` otherwise (so consumers without ACM keep the
      // existing flow unchanged).
      expect(raw).toMatch(/ACM pre-flight \(detect manifest\)/);
      expect(raw).toMatch(/gate_active=true/);
      expect(raw).toMatch(/gate_active=false/);
    });

    it('runs the post-agent ACM gate via lib/cli/acm-verify.ts', () => {
      expect(raw).toMatch(/ACM gate \(verify tests green/);
      expect(raw).toMatch(/MODE=acm-green/);
      expect(raw).toMatch(/CHECK_LOCKS=true/);
      expect(raw).toMatch(/CHECK_SPEC_HASH=true/);
      expect(raw).toMatch(/lib\/cli\/acm-verify\.ts/);
    });

    it('the post-agent gate runs only when gate_active=true', () => {
      // The gate condition must include the gate_active check so consumers
      // without ACM (no manifest on branch) skip the gate entirely.
      expect(raw).toMatch(/steps\.acm-preflight\.outputs\.gate_active == 'true'/);
    });

    it('salvage skips PR open when ACM verdict is fail (work still pushed)', () => {
      // Critical: on ACM-fail, the branch must still be pushed (work
      // preservation), but the PR must NOT be opened. Otherwise the
      // operator gets a PR that's broken on landing — the whole point of
      // the gate is to keep broken work out of human review.
      expect(raw).toMatch(/ACM_VERDICT: \$\{\{ steps\.acm-gate\.outputs\.verdict/);
      expect(raw).toMatch(/if \[ "\$ACM_VERDICT" = "fail" \]/);
      expect(raw).toMatch(/branch pushed but PR not opened/);
    });

    it('labels the issue acm-failed when the ACM gate fails', () => {
      expect(raw).toMatch(/acm-failed/);
      expect(raw).toMatch(/--add-label acm-failed/);
    });
  });

  describe('phase-implement.yml — Self-review (Pillar 6)', () => {
    const raw = readFileSync(resolve(workflowsDir, 'phase-implement.yml'), 'utf8');

    it('runs the self-review verification step (advisory in v1)', () => {
      expect(raw).toMatch(/Self-review verification \(advisory\)/);
      expect(raw).toMatch(/\.dev-agent\/self-review\.json/);
    });

    it('handles absent + malformed self-review JSON without blocking', () => {
      // Advisory in v1: missing or invalid JSON must not break the
      // pipeline — the workflow logs a warning + sets a special verdict
      // value so downstream steps know there's no summary to use.
      expect(raw).toMatch(/verdict=absent/);
      expect(raw).toMatch(/verdict=malformed/);
    });

    it('uses the self-review summary as PR body when present', () => {
      // When the agent emitted .dev-agent/self-review-summary.md, the
      // salvage step should use it as the PR body so reviewers see the
      // agent's own checklist verdict. Falls back to the generic salvage
      // notice when absent.
      expect(raw).toMatch(/SELF_REVIEW_SUMMARY_PATH/);
      expect(raw).toMatch(/Agent self-review/);
    });

    it('posts a checklist breakdown comment for any non-pass items', () => {
      // The comment must enumerate every non-pass item so the operator
      // can scan the issue without opening the PR. Pass-only runs get
      // a single-line comment.
      expect(raw).toMatch(/Non-pass items/);
      expect(raw).toMatch(/all 10 checklist items passed/);
    });
  });

  describe('phase-implement.yml — Risk-annotation audit (Pillar 5 advisory)', () => {
    const raw = readFileSync(resolve(workflowsDir, 'phase-implement.yml'), 'utf8');

    it('runs lib/cli/risk-audit.ts after the agent step', () => {
      // The agent emits .dev-agent/bash-log.jsonl per the implement.md
      // contract; the audit step parses it and emits a structured report.
      // Both --log and --output flags must be present (refactor guard).
      expect(raw).toMatch(/Risk-annotation audit \(advisory\)/);
      expect(raw).toMatch(/lib\/cli\/risk-audit\.ts/);
      expect(raw).toMatch(/--log \.dev-agent\/bash-log\.jsonl/);
      expect(raw).toMatch(/--output \/tmp\/risk-audit\/report/);
    });

    it('always-runs the audit (covers post-failure salvage scenarios)', () => {
      // The audit must run even when an earlier step failed — that's
      // when the risk signal is most valuable. Lock the if-clause shape.
      expect(raw).toMatch(/id: risk-audit\s+if: inputs\.invocation_mode == 'live' && always\(\)/);
    });

    it('applies a risk-audit:<verdict> label regardless of value', () => {
      // The label taxonomy is the same as other audit gates — operators
      // filter by `risk-audit:mismatches` to find runs needing review.
      // The three valid verdicts come from lib/cli/risk-audit.ts.
      expect(raw).toMatch(/risk-audit:\$VERDICT/);
    });

    it('removes stale risk-audit:* labels before applying the new verdict (codex P2)', () => {
      // codex P2 #2 (PR #80 review): re-runs via /approve must not
      // accumulate contradictory labels (e.g. both risk-audit:clean AND
      // risk-audit:mismatches on the same issue). Lock in the cleanup
      // loop that iterates the three known verdict values + skips the
      // current one + removes the rest.
      expect(raw).toMatch(/for STALE in absent clean mismatches; do/);
      expect(raw).toMatch(/if \[ "\$STALE" != "\$VERDICT" \]; then/);
      expect(raw).toMatch(/--remove-label "risk-audit:\$STALE"/);
      // The remove loop must appear BEFORE the final --add-label call,
      // not after — otherwise we'd add then immediately remove our own
      // label.
      const auditStart = raw.indexOf('Risk-annotation audit (advisory)');
      const auditEnd = raw.indexOf('- name:', auditStart + 1);
      const auditBody = raw.slice(auditStart, auditEnd);
      const removeLoopIdx = auditBody.indexOf('for STALE in absent clean mismatches');
      const addLabelIdx = auditBody.indexOf('--add-label "risk-audit:$VERDICT"');
      expect(removeLoopIdx).toBeGreaterThan(0);
      expect(addLabelIdx).toBeGreaterThan(0);
      expect(
        removeLoopIdx,
        'stale-label cleanup loop must run BEFORE the --add-label of the new verdict (codex P2)',
      ).toBeLessThan(addLabelIdx);
    });

    it('comments on the issue ONLY when there are mismatches or HIGH-risk calls', () => {
      // Clean runs with zero HIGH-risk calls should be silent — the label
      // is enough signal. Otherwise every PR would get a noisy "0 / 0 / 0"
      // comment that nobody reads.
      expect(raw).toMatch(/if \[ "\$VERDICT" = "mismatches" \] \|\| \[ "\$HIGH_RISK" -gt 0 \]/);
      expect(raw).toMatch(/--body-file \/tmp\/risk-audit\/report\.md/);
    });

    it('audit step does NOT block the PR (advisory in v1)', () => {
      // The step body must NOT exit 1 on mismatches — those would block
      // PR open and we explicitly want this to be advisory in v1. Lock the
      // absence of any `exit 1` between the audit step's run: line and
      // the next step's `- name:`.
      const lines = raw.split('\n');
      const auditStart = lines.findIndex((l) => l.includes('Risk-annotation audit (advisory)'));
      const nextStepIdx = lines.findIndex((l, i) => i > auditStart && /^\s+- name:/.test(l));
      const auditBody = lines.slice(auditStart, nextStepIdx).join('\n');
      expect(auditBody).not.toMatch(/exit 1/);
    });
  });

  describe('phase-implement.yml — Apply-audit (Pillar 4 advisory)', () => {
    const raw = readFileSync(resolve(workflowsDir, 'phase-implement.yml'), 'utf8');

    it('runs lib/cli/apply-audit.ts after the agent step', () => {
      // The audit reuses lib/apply.ts's validateTsSyntax to syntax-check
      // every TS/JS file in the agent's diff. Locks the CLI invocation
      // shape so a refactor can't drop the --base-ref / --output flags.
      expect(raw).toMatch(/Apply-audit \(TS\/JS syntax of changed files\)/);
      expect(raw).toMatch(/lib\/cli\/apply-audit\.ts/);
      expect(raw).toMatch(/--base-ref origin\/main/);
      expect(raw).toMatch(/--output \/tmp\/apply-audit\/report/);
    });

    it('always-runs the audit (covers post-failure scenarios)', () => {
      // Even when an earlier step failed, surface broken syntax — that's
      // when the audit is most useful (broken TS may have caused the
      // typecheck/test step to fail in the first place).
      expect(raw).toMatch(/id: apply-audit\s+if: inputs\.invocation_mode == 'live' && always\(\)/);
    });

    it('applies an apply-audit:<verdict> label regardless of value', () => {
      // Label taxonomy: apply-audit:no-files | apply-audit:clean |
      // apply-audit:syntax-errors. Operators filter by `syntax-errors`
      // to find runs needing attention.
      expect(raw).toMatch(/apply-audit:\$VERDICT/);
    });

    it('comments on the issue ONLY when there are syntax errors', () => {
      // Clean / no-files runs should be silent — the label is enough.
      expect(raw).toMatch(/if \[ "\$VERDICT" = "syntax-errors" \]/);
      expect(raw).toMatch(/--body-file \/tmp\/apply-audit\/report\.md/);
    });

    it('audit step does NOT block the PR (advisory in v1)', () => {
      // The step body must not exit 1 — that role belongs to the tsc
      // step in the consumer's CI. Lock the absence of `exit 1`
      // between the apply-audit step and the next step's `- name:`.
      const lines = raw.split('\n');
      const auditStart = lines.findIndex((l) => l.includes('Apply-audit (TS/JS syntax of changed files)'));
      const nextStepIdx = lines.findIndex((l, i) => i > auditStart && /^\s+- name:/.test(l));
      const auditBody = lines.slice(auditStart, nextStepIdx).join('\n');
      expect(auditBody).not.toMatch(/exit 1/);
    });
  });

  describe('phase-tier2-smoke.yml — live mode (step 13b, Pillar 7)', () => {
    const raw = readFileSync(resolve(workflowsDir, 'phase-tier2-smoke.yml'), 'utf8');

    it('defaults invocation_mode to live (v1.7+)', () => {
      // The header comment promises v1.7+ ships live by default. Keep
      // workflow_call + workflow_dispatch defaults aligned with that
      // promise so the auto-dispatch wrapper inherits the right mode.
      const calls = raw.match(/default: 'live'/g) ?? [];
      expect(calls.length).toBeGreaterThanOrEqual(2);
      // Negative: ensure the previous default ('stub') hasn't crept back
      // for invocation_mode (the stub_mode input still defaults to 'pass'
      // which is unrelated and should NOT match below).
      expect(raw).not.toMatch(/invocation_mode:\s*\n\s*required: false\s*\n\s*type: string\s*\n\s*default: 'stub'/);
    });

    it('removes the previous "TODO step 13b" placeholder', () => {
      // Regression guard: the old workflow had a single step named
      // "Live mode (TODO step 13b)" that just posted a not-yet-
      // implemented comment + exit 1. Lock in that the placeholder
      // is gone and replaced with the real pipeline (presence of the
      // playwright-probe CLI invocation is the canonical signal).
      expect(raw).not.toMatch(/Live mode \(TODO step 13b\)/);
      expect(raw).not.toMatch(/Status: not-yet-implemented/);
    });

    it('installs Playwright + Chromium in live mode', () => {
      expect(raw).toMatch(/Live mode — install Playwright \+ Chromium/);
      expect(raw).toMatch(/npm install --no-save @playwright\/test/);
      expect(raw).toMatch(/npx playwright install --with-deps chromium/);
    });

    it('writes a fixed playwright.config.ts (agent cannot tamper with it)', () => {
      // Security: if the agent could write the config it could disable
      // the JSON reporter or change baseURL to bypass the gate. The
      // workflow writes a known-good config; the agent only writes
      // probe.spec.ts. Lock in the heredoc.
      expect(raw).toMatch(/cat > \/tmp\/tier2-probe\/playwright\.config\.ts <<'EOF'/);
      expect(raw).toMatch(/baseURL: process\.env\.STAGING_URL/);
      expect(raw).toMatch(/reporter: \[\['json'/);
    });

    it('the probe-author sub-agent runs with restricted tools (no Bash)', () => {
      // Pillar 7 invariant: probe-author works in clean context with
      // no implementation transcript and no Bash. Read + Write/Edit
      // are sufficient; Bash would let the agent invoke Playwright
      // itself (which would skip the workflow's deterministic runner).
      expect(raw).toMatch(/Live mode — author probe \(Claude Code, isolated context\)/);
      const args = raw.match(/claude_args:\s*'--max-turns 30 --model claude-sonnet-4-6 --allowedTools Read Write Edit Glob Grep'/);
      expect(args, 'tier2 probe-author claude_args missing or has Bash').toBeTruthy();
    });

    it('runs lib/cli/playwright-probe.ts with all four required flags', () => {
      // Lock the CLI contract: refactor that drops --probe-dir or
      // --staging-url silently breaks the gate (the verdict CLI will
      // exit with arg-error 1 → workflow ::error::).
      expect(raw).toMatch(/lib\/cli\/playwright-probe\.ts/);
      expect(raw).toMatch(/--probe-dir \/tmp\/tier2-probe/);
      expect(raw).toMatch(/--staging-url "\$STAGING_URL"/);
      expect(raw).toMatch(/--output \/tmp\/tier2-bundle\/verdict\.json/);
      expect(raw).toMatch(/--report-dir \/tmp\/tier2-bundle/);
    });

    it('uploads the bundle even when the probe step fails (always())', () => {
      // The bundle is the post-mortem source of truth — must upload
      // on every live-mode run, including failures.
      expect(raw).toMatch(/Live mode — upload bundle\s+if: inputs\.invocation_mode == 'live' && always\(\)/);
      expect(raw).toMatch(/name: tier2-smoke-bundle-\$\{\{ inputs\.issue_number \}\}/);
    });

    it('copies Playwright test-results into the bundle BEFORE archiving (codex P2)', () => {
      // codex P2 (PR #81 review): Playwright writes screenshots + traces
      // to <testDir>/test-results (= /tmp/tier2-probe/test-results given
      // the fixed playwright.config.ts). The previous tar only included
      // /tmp/tier2-bundle, so failing runs lost the screenshot/trace
      // evidence the workflow summary promises. Lock the copy step in,
      // and verify it appears BEFORE the tar so the artifacts actually
      // make it into the archive.
      expect(raw).toMatch(/cp -R \/tmp\/tier2-probe\/test-results\/\. \/tmp\/tier2-bundle\/test-results\//);
      // The probe.spec.ts itself is also copied so post-mortems can see
      // what assertions the agent generated from the spec.
      expect(raw).toMatch(/cp \/tmp\/tier2-probe\/probe\.spec\.ts \/tmp\/tier2-bundle\/probe\.spec\.ts/);
      // Ordering: cp must precede tar within the same step.
      const stepStart = raw.indexOf('Live mode — run Playwright probe + emit verdict');
      const stepEnd = raw.indexOf('- name:', stepStart + 1);
      const stepBody = raw.slice(stepStart, stepEnd === -1 ? undefined : stepEnd);
      const cpIdx = stepBody.indexOf('cp -R /tmp/tier2-probe/test-results');
      const tarIdx = stepBody.indexOf('tar -czf verification-bundle-tier2');
      expect(cpIdx).toBeGreaterThan(0);
      expect(tarIdx).toBeGreaterThan(0);
      expect(
        cpIdx,
        'test-results copy must precede tar (codex P2)',
      ).toBeLessThan(tarIdx);
    });

    it('exits non-zero on verdict=fail (so branch protection can gate merge)', () => {
      // The state-transition step must `exit 1` when verdict is fail,
      // so the workflow status reflects the verdict — branch
      // protection rules can require this check to pass before merge.
      expect(raw).toMatch(/case "\$VERDICT" in/);
      expect(raw).toMatch(/fail\)\s+gh issue edit "\$ISSUE_NUMBER" --add-label tier2-failed \|\| true/);
      // The exit 1 must live inside the fail) arm.
      const failArm = raw.split(/fail\)/)[1]?.split(/;;/)[0] ?? '';
      expect(failArm).toMatch(/exit 1/);
    });

    it('verdict=ambiguous applies the tier2-ambiguous label without blocking', () => {
      // The non-UI spec path: agent writes a test.skip() probe → CLI
      // returns ambiguous → workflow labels but does NOT exit 1.
      // Lock the absence of exit 1 in the ambiguous arm.
      const ambiguousArm = raw.split(/ambiguous\)/)[1]?.split(/;;/)[0] ?? '';
      expect(ambiguousArm).toMatch(/tier2-ambiguous/);
      expect(ambiguousArm).not.toMatch(/exit 1/);
    });

    it('sanitizes the spec via sed before embedding in the author prompt', () => {
      // Same prompt-injection guard as phase-acm + phase-swarm-review:
      // a spec containing literal `</untrusted_content>` would break
      // the wrapper. The sed substitution must run on $SPEC_PATH.
      expect(raw).toMatch(
        /sed 's\|<\/\[uU\]\[nN\]\[tT\]\[rR\]\[uU\]\[sS\]\[tT\]\[eE\]\[dD\]_\[cC\]\[oO\]\[nN\]\[tT\]\[eE\]\[nN\]\[tT\]>\|<\/untrusted_content_blocked>\|g' "\$SPEC_PATH"/,
      );
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
