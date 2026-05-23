export type GlossaryEntry = {
  /** Display label, e.g. "Gate B". */
  label: string;
  /** Tooltip body — one line, <= 90 chars. */
  short: string;
  /** Popover body — 2-4 sentences, 80-600 chars. */
  long: string;
  /** Optional "Learn more →" target (runbook URL or in-app route). */
  link?: string;
};

export const GLOSSARY = {
  'gate-b': {
    label: 'Gate B',
    short: 'Human review checkpoint before a PR can promote.',
    long: 'Gate B is the human review checkpoint. After CI is green and the EvidenceBundle is built, the PR waits for you to approve before dev-agent promotes it. Items at Gate B show up in "Needs you now" on Home.',
  },
  'pillar-4': {
    label: 'Pillar 4',
    short: 'Apply-audit: confirms the diff matches the spec.',
    long: 'Pillar 4 (apply-audit) reads the agreed spec and the actual PR diff side-by-side and flags any change that was not in the spec. It runs on every dev-agent PR and posts a summary as a check.',
  },
  'pillar-5': {
    label: 'Pillar 5',
    short: 'Risk-audit: ranks bug-likelihood across files.',
    long: 'Pillar 5 (risk-audit) scores each touched file by historical bug density and review depth. A high score does not block the PR — it tells you where to focus your review.',
  },
  'tier2-smoke': {
    label: 'Tier-2 smoke',
    short: 'Spins up the consumer stack end-to-end before merge.',
    long: 'Tier-2 smoke (Pillar 7) installs the PR into a clean copy of the consumer repo, boots it, and exercises the golden-path scenario. Catches integration regressions that unit tests miss.',
  },
  'evidence-bundle': {
    label: 'EvidenceBundle',
    short: 'The artifact bundle that proves a PR is safe to merge.',
    long: 'Every PR generates an EvidenceBundle: test output, audit reports, traces, and screenshots if applicable. Stored as a workflow artifact and summarized as a single Markdown comment on the PR.',
  },
  'scout': {
    label: 'scout',
    short: 'Background source that proposes work for you.',
    long: 'A scout watches an external signal (Sentry errors, GitHub issues, drift between repos) and proposes features or fixes. Proposals show up in the "PM proposes" band and on the Proposals page.',
  },
  'swarm-override': {
    label: 'swarm override',
    short: 'Forces a re-review with extra reviewers when something looks off.',
    long: 'Swarm override is an escape hatch: if the default reviewer set seems too thin for a risky PR, this triggers extra reviewers (the "swarm"). Ships as a per-repo workflow you can install from the repo workspace.',
  },
  'wire-up': {
    label: 'wire-up',
    short: "Installing dev-agent's workflows into a repo.",
    long: 'Wire-up installs the required GitHub Actions workflows into a target repo so dev-agent can plan, build, audit, and promote PRs there. Each repo is wired once from the Repos page.',
  },
  'pm-agent': {
    label: 'PM agent',
    short: 'The chat agent that turns ideas into specs.',
    long: 'The PM agent is the chat on the Brainstorm page. You describe what you want; it asks clarifying questions, drafts a spec, and once you approve, hands off to implementation. The most common way to start something new.',
  },
  'needs-you-now': {
    label: 'Needs you now',
    short: 'Items at a gate, waiting on you to act.',
    long: 'Anything that has stopped at a human-required gate: Gate B reviews, approvals on proposed scope, conflict resolutions. Sorted oldest-first so nothing rots.',
  },
  'in-motion': {
    label: 'In motion',
    short: 'Runs currently executing in CI.',
    long: 'Features currently being built — a workflow run is active or a PR is in flight. Watch the progress chip; click into the feature for the live run drawer.',
  },
  'verification-posture': {
    label: 'verification posture',
    short: 'Rollup of how green your pillars look right now.',
    long: "A one-strip summary of each verification pillar's recent pass rate across all wired repos. Green = healthy; yellow = degrading; red = needs attention.",
  },
  'recently-shipped': {
    label: 'Recently shipped',
    short: 'Features merged in the last 7 days, with verification chips.',
    long: "Last week's merges, with the per-PR verification chip strip inline so you can see at a glance which pillars were green at merge time.",
  },
  'pm-proposes': {
    label: 'PM proposes',
    short: 'Suggestions from scouts, ranked for you.',
    long: 'Proposals collected by the scouts (Sentry, GitHub, drift). Top items appear on Home; the full ranked list is on the Proposals page.',
  },
  'home-page': {
    label: 'Home',
    short: 'Cross-repo command center.',
    long: "Everything that needs you, what's in motion, what shipped, and what your scouts propose — all across every wired repo. For \"everything about one repo\" use the Repo workspace instead.",
  },
  'repos-page': {
    label: 'Repos',
    short: 'Wire up repos and open per-repo workspaces.',
    long: 'List of every GitHub repo you can access. Wire up new ones, and click any wired repo to open its workspace: one rich page for that repo with in-flight features, proposals, recent shipments, cost, and settings.',
  },
  'intent-page': {
    label: 'Brainstorm',
    short: 'Talk to the PM agent to start new work.',
    long: 'Describe a feature, bug, or idea. The PM agent asks clarifying questions, drafts a spec, and once you approve, hands off to implementation. The most common way to start something new.',
  },
  'pipeline-page': {
    label: 'Pipeline',
    short: 'Every in-flight feature by gate, across all repos.',
    long: "Kanban-style view of features by gate. Useful when you want to see \"what's stuck and where\" rather than \"what needs me right now\" — Home answers the latter.",
  },
  'proposals-page': {
    label: 'Proposals',
    short: 'Full ranked list of scout suggestions.',
    long: 'Every proposal from every scout, ranked. Snooze, dismiss, or pull into Brainstorm. Use the repo filter to scope to one repo.',
  },
  'activity-page': {
    label: 'Activity',
    short: 'Audit log of everything dev-agent did recently.',
    long: "Append-only event log: scans, runs, gate transitions, merges, scout fires. Useful when you're asking \"why did that happen?\"",
  },
  'cost-page': {
    label: 'Cost',
    short: 'Token + workflow spend, with watchdog status.',
    long: 'Per-repo and per-feature cost charts. The cost watchdog drops implausible outliers; remaining anomalies surface here for review.',
  },
} as const satisfies Record<string, GlossaryEntry>;

export type TermKey = keyof typeof GLOSSARY;
