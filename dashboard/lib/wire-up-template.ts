/**
 * Embedded copy of `examples/web-app-template/` files used by the wireUpRepo
 * server action when onboarding a new consumer.
 *
 * SOURCE-OF-TRUTH: `examples/web-app-template/` in this repo. The embedded
 * copies here can drift if the templates change — `wire-up-template.test.ts`
 * (engine-side) verifies this file matches the on-disk templates. If you
 * update the templates, copy the new content into the constants below and
 * re-run the tests.
 *
 * Why embed instead of read at runtime: Vercel deploys the dashboard with
 * `rootDirectory: dashboard/`, which excludes parent paths like
 * `../examples/`. Embedding makes the action self-contained and survives the
 * deployment boundary.
 */

export const TEMPLATE_DEV_AGENT_YML = `schema_version: 1

# Tune these to match your repo. The fields below are sized for a typical
# Next.js + TypeScript + Vercel project; adjust if you're on a different
# stack.

commands:
  test: npm test
  build: npm run build
  typecheck: npm run typecheck
  lint: npm run lint

branches:
  default: main
  # Set staging if you have a long-lived staging branch (e.g. develop).
  # Leave null for repos where main → preview deploy is the staging path.
  staging: null
  release_target: main
  release_pr_required: true

deploy_skills:
  # Names map to scripts/<name>.sh OR .claude/skills/<name>/SKILL.md
  # in this repo — whichever the agent finds first.
  staging:
    - vercel-deploy-preview
  prod:
    - vercel-promote-to-prod

audit_skills:
  pre_pr: []

scaffold_skills: {}

artifacts:
  specs_dir: docs/specs
  plans_dir: docs/plans
  status_file: docs/program-status.md
  runbooks_dir: docs/runbooks

guardrails:
  # Paths the agent must NEVER touch. Anything under these globs is
  # treated as a hard fail — the agent aborts rather than edit them.
  blocked_paths:
    - .env*
    - secrets/**
    - "**/*.pem"
    - "**/*.key"
    - .github/workflows/**         # workflows themselves edited via PR review only
    - supabase/migrations/**       # schema changes go through DBAs
    - prisma/migrations/**
    - .vercel/**
  # Paths the agent may modify ONLY if the spec explicitly mentions them.
  # Useful for code that's owned by another team or has invariants the
  # agent can't reason about by reading the file alone.
  require_explicit_unlock:
    - app/api/**             # API routes — surface area for prod traffic
    - lib/payments/**        # payment-handling code
    - lib/auth/**            # auth + session code
    - tests/integration/**   # changes to integration tests need review
  max_files_changed: 30
  max_lines_changed: 800
  scope_creep_thresholds:
    files_outside_spec_scope: 0
    loc_outside_spec_scope: 50
  trivial_cleanup_categories:
    - formatting
    - comment-fix
    - import-sort

cost_caps:
  spec_brainstorm: { tokens_in: 50000,  tokens_out: 8000,  dollars: 1.50 }
  implement:       { tokens_in: 200000, tokens_out: 60000, dollars: 5.00 }
  staging_deploy:  { tokens_in: 30000,  tokens_out: 8000,  dollars: 0.50 }
  promote_to_prod: { tokens_in: 30000,  tokens_out: 8000,  dollars: 0.50 }
  smoke_verify:    { tokens_in: 20000,  tokens_out: 4000,  dollars: 0.20 }
  scout_digest:    { tokens_in: 50000,  tokens_out: 5000,  dollars: 0.50 }
  rollback:        { tokens_in: 30000,  tokens_out: 8000,  dollars: 0.50 }

models:
  scout: claude-haiku-4-5
  triage: claude-haiku-4-5
  smoke_analysis: claude-haiku-4-5
  drift_detection: claude-haiku-4-5
  notification: claude-haiku-4-5
  implementation: claude-sonnet-4-6
  staging_deploy: claude-sonnet-4-6
  promote_to_prod: claude-sonnet-4-6
  rollback: claude-sonnet-4-6
  spec_brainstorm: claude-opus-4-7
  ambiguous_failure: claude-opus-4-7

scout:
  enabled: false
  cron: "0 9 * * 1-5"
  sources: []
  suppression:
    track_rejections: true
    suppress_after_n_rejects: 3

notifications:
  github_issue: true
  status_file: true

hotfix:
  enabled: true
  required_label: "kind:hotfix"
  skip_spec: true
  skip_drift_check: false
`;

export const TEMPLATE_WORKFLOW_YML = `name: dev-agent
# run-name embeds the dispatched phase + issue number so the dashboard
# can match in-flight runs to a specific feature page (it filters
# workflow_runs by \`#<issue>\` in display_title). Without this, every
# run shows the workflow's static name "dev-agent" with no per-issue
# linkability.
run-name: \${{ inputs.phase }} → issue #\${{ inputs.issue_number }} (\${{ inputs.invocation_mode }})

# Wrapper that delegates to alizaouane/dev-agent's reusable phase
# workflows. Drop this file into .github/workflows/ in your repo,
# add ANTHROPIC_API_KEY as a repo secret, and you're wired up.
#
# SECURITY: This wrapper does not use any untrusted event payload data
# in \`run:\` blocks. It only forwards the workflow_dispatch inputs
# (typed as choice or number, validated by GitHub before they reach the
# job) to the reusable workflows. No \`run:\` steps live in this file.

on:
  workflow_dispatch:
    inputs:
      phase:
        description: Which phase to run
        required: true
        type: choice
        options:
          - implement
          - staging-deploy
          - promote-to-prod
          - rollback
      issue_number:
        description: GitHub issue number to act on
        required: true
        type: number
      invocation_mode:
        description: live (call the agent) or stub (skip agent for tests)
        required: false
        type: string
        default: live

# Granted at the workflow level so the called reusable workflows can
# request these permissions for their own jobs. Reusable workflows
# can never elevate above what the caller grants — a caller with
# read defaults causes the called job to fail at startup with
# "but is only allowed contents: read, issues: none, ..." even though
# the reusable's own permissions block asks for write. The union
# below covers all 5 phase workflows; only one runs per dispatch
# (each is gated by an if: condition).
permissions:
  contents: write
  issues: write
  pull-requests: write
  id-token: write

jobs:
  implement:
    if: inputs.phase == 'implement'
    uses: alizaouane/dev-agent/.github/workflows/phase-implement.yml@v1
    with:
      # fromJSON forces a number — \`\${{ inputs.issue_number }}\` is
      # serialized as a string when forwarded to a typed reusable
      # input, which fails with "Unexpected value '143'" at run start.
      issue_number: \${{ fromJSON(inputs.issue_number) }}
      config_path: .dev-agent.yml
      invocation_mode: \${{ inputs.invocation_mode }}
    secrets:
      ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}

  staging-deploy:
    if: inputs.phase == 'staging-deploy'
    uses: alizaouane/dev-agent/.github/workflows/phase-staging-deploy.yml@v1
    with:
      # fromJSON forces a number — \`\${{ inputs.issue_number }}\` is
      # serialized as a string when forwarded to a typed reusable
      # input, which fails with "Unexpected value '143'" at run start.
      issue_number: \${{ fromJSON(inputs.issue_number) }}
      config_path: .dev-agent.yml
      invocation_mode: \${{ inputs.invocation_mode }}
    secrets:
      ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}

  # smoke-verify is intentionally omitted: it's invoked internally by
  # the staging-deploy workflow with captured smoke output, not driven
  # manually. Including it here would require passing smoke_phase /
  # smoke_output / smoke_exit_code (no defaults), which fails
  # workflow validation at startup. Repos that need a manual
  # smoke-verify dispatch should install a dedicated wrapper.

  promote-to-prod:
    if: inputs.phase == 'promote-to-prod'
    uses: alizaouane/dev-agent/.github/workflows/phase-promote-to-prod.yml@v1
    with:
      # fromJSON forces a number — \`\${{ inputs.issue_number }}\` is
      # serialized as a string when forwarded to a typed reusable
      # input, which fails with "Unexpected value '143'" at run start.
      issue_number: \${{ fromJSON(inputs.issue_number) }}
      config_path: .dev-agent.yml
      invocation_mode: \${{ inputs.invocation_mode }}
    secrets:
      ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}

  rollback:
    if: inputs.phase == 'rollback'
    uses: alizaouane/dev-agent/.github/workflows/phase-rollback.yml@v1
    with:
      # fromJSON forces a number — \`\${{ inputs.issue_number }}\` is
      # serialized as a string when forwarded to a typed reusable
      # input, which fails with "Unexpected value '143'" at run start.
      issue_number: \${{ fromJSON(inputs.issue_number) }}
      config_path: .dev-agent.yml
      invocation_mode: \${{ inputs.invocation_mode }}
    secrets:
      ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
`;

export const TEMPLATE_PM_MD = `---
# PM agent's persistent memory. Edit this file directly — the dashboard
# also lets the PM propose updates after big decisions, but you own the
# final state. Every field is optional.

# What you're trying to do, period. The PM ranks proposals against these.
# Use any keys you want; the structure is just \`key: one-line description\`.
goals:
  near_term: "Replace this with one sentence about what you're focused on this quarter."
  # mid_term: "..."

# Things the PM should NOT propose, even if they look reasonable.
# Examples:
#   - "operational complexity for the studio owner"
#   - "anything requiring a backend rewrite"
#   - "third-party integrations we don't already have a contract with"
avoid: []

# Decisions you (or the PM) have made. The PM checks this before
# proposing anything that was rejected/deferred recently.
recent_decisions: []
# Example shape:
# recent_decisions:
#   - date: "2026-05-10"
#     decision: "Rejected: mobile-app proposal #45"
#     reason: "Too much scope for this quarter; revisit Q4."
#     revisit_after: "2026-10-01"

# Competitors the PM should watch. Each entry surfaces as a "review
# competitor X" proposal on /proposals — click "Discuss with PM" to
# extract feature ideas relevant to your goals. Snooze handles noise.
competitors: []
# Example shape:
# competitors:
#   - name: "StudioDirector"
#     url: "https://studiodirector.com/blog"
#     notes: "Closest direct competitor; watch their pricing changes."

last_updated: "2026-05-04"
---

# Product manager notes

This file is your scratchpad for the PM agent. Free-form markdown below
the frontmatter — the PM reads it as context when reasoning about
proposals.

## Background

(One paragraph: what does this product do, who's it for, what's the
shape of the team behind it. The PM uses this to calibrate proposals
against your reality, not a generic web-app template.)

## Open questions

(Things you're undecided about. The PM may surface relevant proposals
when answering these.)

## Recent context the PM should know

(Anything that matters that doesn't fit elsewhere — a competitor moved,
an investor asked for X, a customer churned because of Y.)
`;

export const TEMPLATE_BUG_SCOUT_WORKFLOW_YML = `name: dev-agent · bug-scout

# Periodic bug-scout. Runs an LLM agent against your codebase
# daily + on-demand. Findings file as GitHub issues with
# \`kind:bug-scout\` + \`state:proposed\` and surface on the dashboard's
# /proposals page. Cost ~\$0.30-1.00/scan, ~\$9-30/month at daily
# cadence — adjust the cron expression if you need it less often.
#
# SECURITY: no \`run:\` blocks; only typed inputs forward to the
# reusable workflow.

on:
  schedule:
    # Daily 09:00 UTC. Findings accumulate as a queue you triage
    # at your own pace via /proposals on the dashboard.
    - cron: '0 9 * * *'
  workflow_dispatch:
    inputs:
      focus_paths:
        description: Globs to prioritize (e.g. lib/auth/**,app/api/**)
        required: false
        type: string
        default: ''
      ignore_paths:
        description: Globs to skip
        required: false
        type: string
        default: 'node_modules/**,dist/**,build/**,.next/**,coverage/**'

jobs:
  bug-scout:
    uses: alizaouane/dev-agent/.github/workflows/phase-bug-scout.yml@v1
    with:
      config_path: .dev-agent.yml
      focus_paths: \${{ inputs.focus_paths || '' }}
      ignore_paths: \${{ inputs.ignore_paths || 'node_modules/**,dist/**,build/**,.next/**,coverage/**' }}
      invocation_mode: live
    secrets:
      ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
`;

export const TEMPLATE_UNFINISHED_WORK_SCOUT_WORKFLOW_YML = `name: dev-agent · unfinished-work-scout

# On-demand "Scan with PM" — runs an LLM agent against your codebase
# looking for unfinished work the deterministic scouts in the dashboard
# missed: stubs, half-shipped features, abandoned migrations, untracked
# specs, skipped tests. Findings file as GitHub issues with
# \`kind:unfinished-work\` + \`state:proposed\` and surface on
# /proposals.
#
# Cost ~\$0.10-0.30 per scan. Manual trigger only — fire it from the
# "Scan with PM" button on /repos/<this-repo> when you want a deeper
# read than the per-page heuristic scout offers.
#
# SECURITY: no \`run:\` blocks; only typed inputs forward to the
# reusable workflow.

on:
  workflow_dispatch:
    inputs:
      focus_paths:
        description: Globs to prioritize (e.g. lib/auth/**,app/api/**)
        required: false
        type: string
        default: ''
      ignore_paths:
        description: Globs to skip
        required: false
        type: string
        default: 'node_modules/**,dist/**,build/**,.next/**,coverage/**'

jobs:
  unfinished-work-scout:
    uses: alizaouane/dev-agent/.github/workflows/phase-unfinished-work-scout.yml@v1
    with:
      config_path: .dev-agent.yml
      focus_paths: \${{ inputs.focus_paths || '' }}
      ignore_paths: \${{ inputs.ignore_paths || 'node_modules/**,dist/**,build/**,.next/**,coverage/**' }}
      invocation_mode: live
    secrets:
      ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
`;

export const TEMPLATE_CLEANUP_SCOUT_WORKFLOW_YML = `name: dev-agent · cleanup-scout

# On-demand cleanup scan — runs an LLM agent against your codebase
# looking for code that can be deleted with no behavior change: dead
# exports, skipped tests with stale reasons, deprecated calls, unused
# module-level state, stale dated TODOs, abandoned files. Findings file
# as GitHub issues with \`kind:cleanup\` + \`state:proposed\` and surface
# on /proposals.
#
# Cost ~\$0.10-0.30 per scan. Manual trigger only — cleanup is bulk
# triage, not a continuous safety net. Fire it from the "Run cleanup
# scan" button on /repos/<this-repo> when you want a deletion-class
# review of the codebase.
#
# SECURITY: no \`run:\` blocks; only typed inputs forward to the
# reusable workflow.

on:
  workflow_dispatch:
    inputs:
      focus_paths:
        description: Globs to prioritize (e.g. lib/auth/**,app/api/**)
        required: false
        type: string
        default: ''
      ignore_paths:
        description: Globs to skip
        required: false
        type: string
        default: 'node_modules/**,dist/**,build/**,.next/**,coverage/**'

jobs:
  cleanup-scout:
    uses: alizaouane/dev-agent/.github/workflows/phase-cleanup-scout.yml@v1
    with:
      config_path: .dev-agent.yml
      focus_paths: \${{ inputs.focus_paths || '' }}
      ignore_paths: \${{ inputs.ignore_paths || 'node_modules/**,dist/**,build/**,.next/**,coverage/**' }}
      invocation_mode: live
    secrets:
      ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
`;

export const TEMPLATE_VERIFICATION_WORKFLOW_YML = `name: dev-agent · verification gates
run-name: \${{ github.event_name }} → verification

# Auto-dispatches the verification gates (Pillar 1 / 2 / 5) on issue +
# PR events. Sibling to \`dev-agent.yml\` (which stays workflow_dispatch
# driven for the existing implement / staging-deploy / promote / rollback
# phases). Drop this file into your repo's \`.github/workflows/\` to
# activate the gates; the consumer's \`.dev-agent.yml\` does NOT need any
# additional config to enable them — the gates are universal-by-default
# from v1.5 onward.
#
# Triggers:
#   - issue_comment containing \`/approve\` on an issue labeled
#     state:spec-ready  →  phase-acm.yml (live mode)
#   - pull_request opened|synchronize|reopened on a feat/dev-agent-issue-*
#     branch              →  phase-evidence-collector.yml + phase-swarm-review.yml
#
# Forks: PRs from forked repos are excluded by an explicit same-repo guard
# (\`head.repo.full_name == github.repository\`) on every job. Without that
# guard, \`pull_request\` events from forks would enter the verification jobs
# but then fail downstream — they run with read-only token contexts and
# can't access repo secrets like ANTHROPIC_API_KEY, so claude-code-action
# would crash and the gh-CLI write calls would 403. Skipping the jobs at
# the wrapper level means fork PRs simply don't get verification (which
# branch-protection rules can require for merge), rather than failing
# loudly with a confusing token-permission error.
#
# SECURITY: untrusted GitHub event values (issue/PR titles, bodies,
# comment text) are NEVER interpolated into run: blocks here — this file
# has zero \`run:\` steps. The reusable workflows handle untrusted content
# via the lib/untrusted-content.ts wrapper before any prompt rendering.

on:
  issue_comment:
    types: [created]
  pull_request:
    types: [opened, synchronize, reopened]

# Workflow-level permissions are the cap for the called reusable workflows
# (a reusable can never elevate above what the caller grants).
permissions:
  contents: write
  issues: write
  pull-requests: write
  id-token: write

jobs:
  # Pillar 1 — ACM (Acceptance-Criteria Manifest). Fires when the issue
  # author comments \`/approve\` on a state:spec-ready issue. Generates
  # failing test stubs from the spec's acceptance criteria + advances state.
  acm:
    if: |
      github.event_name == 'issue_comment' &&
      github.event.issue.pull_request == null &&
      startsWith(github.event.comment.body, '/approve') &&
      contains(github.event.issue.labels.*.name, 'state:spec-ready') &&
      github.event.comment.user.login == github.event.issue.user.login
    uses: alizaouane/dev-agent/.github/workflows/phase-acm.yml@v1
    with:
      issue_number: \${{ github.event.issue.number }}
      config_path: .dev-agent.yml
      invocation_mode: live
    secrets:
      ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}

  # Pillar 2a — EvidenceCollector. Runs deterministic scanners (gitleaks,
  # Semgrep, npm audit) and packages the bundle. Fires on PR open /
  # synchronize for any branch matching feat/dev-agent-issue-* AND
  # originating from the same repo (not a fork). Fail-closed on
  # HIGH-severity findings (PR blocked at this gate).
  evidence:
    if: |
      github.event_name == 'pull_request' &&
      github.event.pull_request.head.repo.full_name == github.repository &&
      startsWith(github.event.pull_request.head.ref, 'feat/dev-agent-issue-')
    uses: alizaouane/dev-agent/.github/workflows/phase-evidence-collector.yml@v1
    with:
      pr_number: \${{ github.event.pull_request.number }}
      base_ref: \${{ github.event.pull_request.base.ref }}
      head_ref: \${{ github.event.pull_request.head.ref }}

  # Pillar 2b — SwarmReview. Three reviewers consume the same shared
  # context (v1.5 = PR diff only, v1.6 adds the EvidenceBundle). Aggregator
  # emits one PR comment + one label; on swarm-fail the workflow exits
  # non-zero so branch protection can gate merge on it.
  swarm-review:
    needs: evidence
    if: |
      github.event_name == 'pull_request' &&
      github.event.pull_request.head.repo.full_name == github.repository &&
      startsWith(github.event.pull_request.head.ref, 'feat/dev-agent-issue-')
    uses: alizaouane/dev-agent/.github/workflows/phase-swarm-review.yml@v1
    with:
      pr_number: \${{ github.event.pull_request.number }}
      base_ref: \${{ github.event.pull_request.base.ref }}
      head_ref: \${{ github.event.pull_request.head.ref }}
      invocation_mode: live
    secrets:
      ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
`;

export const TEMPLATE_SESSION_LOG_MD = `# Session Log

(no entries yet — the dev-agent and your dev sessions will append here)

`;

/**
 * Files to drop into a target repo when wiring it up. Order doesn't matter
 * for the GitHub API, but is significant for human review of the resulting
 * PR — we put `.dev-agent.yml` first so reviewers see the config before
 * the workflow that uses it. `pm.md` ships with placeholder content the
 * user is expected to edit before the PM agent has anything useful to do.
 * The bug-scout workflow ships with a daily cron pre-wired; the
 * unfinished-work-scout and cleanup-scout ship with workflow_dispatch
 * only (manual trigger).
 * The verification workflow activates automatically on issue and PR events,
 * running the swarm-review verification gates without requiring manual dispatch.
 * `SESSION_LOG.md` ships empty — every dev cycle and every user-approved
 * scope appends here, giving the PM agent durable activity context for
 * grounding (so empty `pm.md` stops mattering).
 */
export const WIRE_UP_FILES: Array<{ path: string; content: string }> = [
  { path: '.dev-agent.yml', content: TEMPLATE_DEV_AGENT_YML },
  { path: '.github/workflows/dev-agent.yml', content: TEMPLATE_WORKFLOW_YML },
  { path: '.github/workflows/dev-agent-bug-scout.yml', content: TEMPLATE_BUG_SCOUT_WORKFLOW_YML },
  {
    path: '.github/workflows/dev-agent-unfinished-work-scout.yml',
    content: TEMPLATE_UNFINISHED_WORK_SCOUT_WORKFLOW_YML,
  },
  {
    path: '.github/workflows/dev-agent-cleanup-scout.yml',
    content: TEMPLATE_CLEANUP_SCOUT_WORKFLOW_YML,
  },
  {
    path: '.github/workflows/dev-agent-verification.yml',
    content: TEMPLATE_VERIFICATION_WORKFLOW_YML,
  },
  { path: '.dev-agent/pm.md', content: TEMPLATE_PM_MD },
  { path: 'SESSION_LOG.md', content: TEMPLATE_SESSION_LOG_MD },
];

/**
 * Installable workflows that older wire-ups may be missing. Drives the
 * one-click "Install" buttons on /repos/[name] so the user can backfill
 * any missing workflow without re-running the full wire-up (which would
 * require deleting `.dev-agent.yml` first to pass the already-wired guard).
 * Covers three scout workflows (bug-scout, unfinished-work, cleanup) plus the
 * verification-gates workflow introduced in v1.5.
 */
export const INSTALLABLE_WORKFLOWS = {
  'bug-scout': {
    path: '.github/workflows/dev-agent-bug-scout.yml',
    content: TEMPLATE_BUG_SCOUT_WORKFLOW_YML,
    label: 'Bug-scout',
  },
  'unfinished-work': {
    path: '.github/workflows/dev-agent-unfinished-work-scout.yml',
    content: TEMPLATE_UNFINISHED_WORK_SCOUT_WORKFLOW_YML,
    label: 'PM scan (unfinished-work scout)',
  },
  cleanup: {
    path: '.github/workflows/dev-agent-cleanup-scout.yml',
    content: TEMPLATE_CLEANUP_SCOUT_WORKFLOW_YML,
    label: 'Cleanup scan',
  },
  verification: {
    path: '.github/workflows/dev-agent-verification.yml',
    content: TEMPLATE_VERIFICATION_WORKFLOW_YML,
    label: 'Verification gates (swarm-review)',
  },
} as const;

export type WorkflowKey = keyof typeof INSTALLABLE_WORKFLOWS;

export const WORKFLOW_KEYS: WorkflowKey[] = Object.keys(
  INSTALLABLE_WORKFLOWS,
) as WorkflowKey[];
