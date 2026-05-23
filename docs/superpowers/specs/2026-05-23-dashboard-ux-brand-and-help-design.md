# Dashboard UX — Brand Refresh + Inline Help + Nav Restructure

**Status:** Spec drafted 2026-05-23.
**Author:** ali (with Claude Code, brainstorming skill)
**Branch context:** drafted on `feat/v1-cleanup-bundle`; implementation should land on its own branch.

## Problem

The 2026-05-09 dashboard redesign (PR #84) shipped the two-layer surface (Global Home + Per-repo Workspace) and verification visibility. After several weeks of daily use, the primary user still reports:

1. **"I get lost and confused"** — the layout works, but jargon is dense (Pillar 4, Gate B, Tier-2 smoke, EvidenceBundle, swarm override, scout, wire-up) and nothing on-page explains what these terms mean. The global Help drawer (`components/help-panel.tsx`) is a 30-second pitch, not a reference.
2. **"It's not clear how the app works"** — page-level orientation is thin. Each page jumps straight into bands and tables with no descriptor of what the page is for or what each band means.
3. **Navigation reads as a flat list** — the nav has 3 primary + 4 secondary text links separated by `|`. There's no section grouping, no active-page indicator, and no breadcrumb on inner pages — you can't tell where you are or what neighborhood you're in.
4. **Visual identity is generic** — current palette is shadcn default (black/white/gray). The product lives at `dev-agent.qualiency.com` but doesn't visually belong to Qualiency — no navy/teal brand presence.

These are reinforcing problems: dense jargon + thin orientation + flat nav + generic skin all push toward the same "I don't know what I'm looking at" feeling.

## Goal

After this redesign:
- Every piece of jargon on every page is hover-explainable and click-expandable, without leaving the page.
- Every page tells you what it's for in one italic line under the H1.
- The nav shows you where you are (active underline + breadcrumb) and groups secondary items by purpose.
- The dashboard visually reads as part of Qualiency — navy primary, teal accent, white surfaces — without a heavy rebrand.

## Non-goals

- No font swap (system sans stays).
- No new icon library; use inline SVG or what's already in the repo.
- No animation framework (CSS transitions only).
- No mobile redesign — maintain today's responsive collapse, don't redesign for it.
- No internationalization.
- No new pages or routes.
- No first-visit onboarding tour (user explicitly opted out of this scope item).
- No changes to PM chat (`/intent`, `pm-chat.tsx`), scouts, the verification engine, GitHub OAuth, or the repo allowlist.
- No changes to the band structure on Home or Repo Workspace — bands and ordering are preserved from PR #84.

---

## Approach (selected)

**Brand-aligned re-skin + ambient inline help + sectioned top nav.**

Three coordinated changes:

1. **Brand palette** — swap CSS color tokens to a Qualiency-aligned set (navy primary, teal accent, white surfaces, light-gray section backgrounds), with dark-mode parity. Components don't change shape; they just inherit the new tokens.
2. **Inline help via `<Term>`** — a single component that wraps any jargon string. Hover shows a 1-line tooltip; click opens a popover with a 2–4 sentence explainer + optional link. Backed by a `lib/glossary.ts` single source of truth.
3. **Sectioned top nav** — primary triad unchanged (Home · Repos · Brainstorm); secondary items grouped under inline `WORK` and `INSIGHTS` labels. Active page gets a teal underline. Inner pages get a `<Breadcrumbs />` strip under the header.

(An alternate "About this page" collapsible-panel approach was considered and rejected — it puts help one click away from the confusion, not next to it; users said the on-page jargon is what loses them.)

---

## Brand palette

Edit `dashboard/app/globals.css` to replace the current token block. Values are HSL components (matching the existing `hsl(var(--token))` consumption pattern in `tailwind.config.ts`).

### Light mode (default)

| Token | Value | Role |
|---|---|---|
| `--background` | `0 0% 100%` | Page background (white) |
| `--foreground` | `220 25% 15%` | Body text (near-navy) |
| `--primary` | `220 30% 18%` | Qualiency navy — headers, primary buttons |
| `--primary-foreground` | `0 0% 100%` | Text on primary |
| `--accent` | `180 75% 40%` | Qualiency teal — links, active nav underline, focus rings, accent CTAs |
| `--accent-foreground` | `0 0% 100%` | Text on accent |
| `--secondary` | `210 17% 97%` | Light cool-gray for section backgrounds |
| `--secondary-foreground` | `220 25% 15%` | Text on secondary |
| `--muted` | `210 14% 93%` | Subtle muted surfaces |
| `--muted-foreground` | `220 10% 40%` | Muted text |
| `--border` | `220 14% 90%` | Borders |
| `--input` | `220 14% 90%` | Form input borders |
| `--ring` | `180 75% 40%` | Focus ring (teal) |
| `--card` | `0 0% 100%` | Card background |
| `--card-foreground` | `220 25% 15%` | Card text |
| `--popover` | `0 0% 100%` | Popover background |
| `--popover-foreground` | `220 25% 15%` | Popover text |
| `--destructive` | `0 75% 50%` | Errors (slightly toned from shadcn default) |
| `--destructive-foreground` | `0 0% 100%` | Text on destructive |
| `--radius` | `0.5rem` | Unchanged |

### Dark mode

| Token | Value |
|---|---|
| `--background` | `220 25% 10%` |
| `--foreground` | `210 17% 95%` |
| `--primary` | `210 17% 95%` |
| `--primary-foreground` | `220 30% 18%` |
| `--accent` | `180 70% 50%` |
| `--accent-foreground` | `220 25% 12%` |
| `--secondary` | `220 20% 16%` |
| `--secondary-foreground` | `210 17% 95%` |
| `--muted` | `220 18% 18%` |
| `--muted-foreground` | `210 14% 65%` |
| `--border` | `220 18% 22%` |
| `--input` | `220 18% 22%` |
| `--ring` | `180 70% 50%` |
| `--card` | `220 25% 12%` |
| `--card-foreground` | `210 17% 95%` |
| `--popover` | `220 25% 12%` |
| `--popover-foreground` | `210 17% 95%` |
| `--destructive` | `0 65% 45%` |
| `--destructive-foreground` | `210 17% 95%` |

### Button variants

Edit `dashboard/components/ui/button.tsx`:
- Existing `variant="default"` stays = navy fill + white text (now reads as Qualiency navy).
- Existing `variant="outline"`: keep neutral border, but change text + hover-border to use `--accent`.
- **New** `variant="accent"`: solid teal (`bg-accent text-accent-foreground hover:bg-accent/90`). Use for the most prominent CTAs (Home "Brainstorm new work" button, intent submit).
- All other variants (`ghost`, `secondary`, `destructive`) inherit the new tokens automatically.

### Link affordance

Inline `<a>` and `<Link>` elements currently rely on `hover:underline`. Add a global rule in `globals.css`:
```css
a:not([class*="bg-"]):not([data-no-style]) {
  color: hsl(var(--accent));
}
a:not([class*="bg-"]):not([data-no-style]):hover {
  text-decoration: underline;
}
```
Buttons rendered as anchors (already have a `bg-*` class) are excluded automatically. Components that need to opt out (e.g., neutral nav items handled below) use `data-no-style`.

---

## Navigation

Rewrite `dashboard/components/nav-header.tsx`.

### Visual shape

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│ ◆ dev-agent    Home · Repos · Brainstorm    │    WORK  Pipeline · Proposals    INSIGHTS  Activity · Cost          [Brainstorm new work →]   (?)   @ali │
│                ━━━━                                                                                                                                       │ ← teal underline marks active page
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
Home › Repos › qualiency/web                                                                                                                                ← breadcrumb on inner pages only
```

### Implementation notes

- `NavHeader` becomes a **client component** (currently server) because it needs `usePathname()` for active-state detection. Auth/session lookup moves into a small server component child (or stays as today via a prop) — pattern: server wrapper fetches session, passes username + signout action to the client `NavHeader`.
- Primary triad: `Home (/)`, `Repos (/repos)`, `Brainstorm (/intent)` — middle-weight links, dot-separated.
- Section labels `WORK` and `INSIGHTS` render as small-caps muted text (`text-xs uppercase tracking-wider text-muted-foreground`), inline with the links beside them. Not dropdowns.
- `WORK` group: `Pipeline (/pipeline)`, `Proposals (/proposals)`.
- `INSIGHTS` group: `Activity (/activity)`, `Cost (/cost)`.
- Active page: detected by `usePathname()` starts-with match. Active link gets `border-b-2 border-accent pb-1 font-medium`. All nav links get `data-no-style` so they don't pick up the global teal link color.
- Mobile: collapse the secondary clusters into a single overflow menu (✱); primary triad + CTA stay visible. Use existing Radix Dialog as the overflow drawer.
- `(?)` icon and username/signout positioning unchanged.

### Breadcrumbs

New file `dashboard/components/ui/breadcrumbs.tsx`:

```tsx
type Crumb = { label: string; href?: string };
export function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) { ... }
```

- Renders `home › crumb1 › crumb2 (current, no link)`.
- Last crumb is plain text; earlier crumbs are links.
- Mounted inside `NavHeader` (below the header bar), driven by `usePathname()` and a small route-to-crumb mapping function in the same file. Top-level pages (`/`, `/repos`, `/intent`, `/pipeline`, `/proposals`, `/activity`, `/cost`) render no breadcrumb. Inner pages do:
  - `/repos/:name` → `Home › Repos › :name`
  - `/features/:issue` → `Home › Features › #:issue` (use `?repo=` query if present to enrich the second crumb)
  - `/intent` with `?repo=…` → `Home › Brainstorm › :repo`
  - `/repos` itself → no crumb (it's a top-level page)

---

## Inline help: `<Term>` + glossary

### Glossary file

New file `dashboard/lib/glossary.ts`:

```ts
export type GlossaryEntry = {
  label: string;   // display text, e.g. "Gate B"
  short: string;   // tooltip body, 1 line, <= 90 chars
  long: string;    // popover body, 2–4 sentences
  link?: string;   // optional "Learn more →" target (runbook URL or in-app route)
};

export const GLOSSARY = {
  'gate-b': {
    label: 'Gate B',
    short: 'Human review checkpoint before a PR can promote.',
    long: 'Gate B is the human review checkpoint. After CI is green and the EvidenceBundle is built, the PR waits for you to approve before dev-agent promotes it. Items at Gate B show up in "Needs you now".',
  },
  'pillar-4': {
    label: 'Pillar 4',
    short: 'Apply-audit: confirms the diff matches the spec.',
    long: 'Pillar 4 (apply-audit) reads the agreed spec and the actual PR diff side-by-side, and flags any change that wasn\'t in the spec. It runs on every dev-agent PR.',
  },
  'pillar-5': {
    label: 'Pillar 5',
    short: 'Risk-audit: ranks bug-likelihood across files.',
    long: 'Pillar 5 (risk-audit) scores each touched file by historical bug density and review depth. A high score doesn\'t block the PR — it tells you where to focus your review.',
  },
  'tier2-smoke': {
    label: 'Tier-2 smoke',
    short: 'Spins up the consumer stack end-to-end before merge.',
    long: 'Tier-2 smoke (Pillar 7) installs the PR into a clean copy of the consumer repo, boots it, and exercises the golden-path scenario. Catches integration regressions that unit tests miss.',
  },
  'evidence-bundle': {
    label: 'EvidenceBundle',
    short: 'The artifact bundle that proves a PR is safe to merge.',
    long: 'Every PR generates an EvidenceBundle: test output, audit reports, traces, screenshots if applicable. Stored as a workflow artifact and summarized as a single Markdown comment on the PR.',
  },
  'scout': {
    label: 'scout',
    short: 'Background source that proposes work for you.',
    long: 'A scout watches an external signal (Sentry errors, GitHub issues, drift between repos) and proposes features or fixes. Proposals show up in the "PM proposes" band and the /proposals page.',
  },
  'swarm-override': {
    label: 'swarm override',
    short: 'Forces a re-review with extra reviewers when something looks off.',
    long: 'Swarm override is an escape hatch: if the default reviewer set seems too thin for a risky PR, this triggers extra reviewers (the "swarm"). Ships as a per-repo workflow.',
  },
  'wire-up': {
    label: 'wire-up',
    short: 'Installing dev-agent\'s workflows into a repo.',
    long: 'Wire-up installs the required GitHub Actions workflows into a target repo so dev-agent can plan, build, audit, and promote PRs there. Each repo is wired once from the Repos page.',
  },
  'pm-agent': {
    label: 'PM agent',
    short: 'The chat agent that turns ideas into specs.',
    long: 'The PM agent is the chat on the Brainstorm page. You describe what you want; it asks clarifying questions, drafts a spec, and hands off to the implementation agent once you approve.',
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
    long: 'A one-strip summary of each verification pillar\'s recent pass rate across all wired repos. Green = healthy; yellow = degrading; red = needs attention.',
  },
  'recently-shipped': {
    label: 'Recently shipped',
    short: 'Features merged in the last 7 days, with verification chips.',
    long: 'Last week\'s merges, with the per-PR verification chip strip inline so you can see at a glance which pillars were green at merge time.',
  },
  'pm-proposes': {
    label: 'PM proposes',
    short: 'Suggestions from scouts, ranked for you.',
    long: 'Proposals collected by the scouts (Sentry, GitHub, drift). Top items appear on Home; the full ranked list is on /proposals.',
  },
  'home-page': {
    label: 'Home',
    short: 'Cross-repo command center.',
    long: 'Everything that needs you, what\'s in motion, what shipped, and what your scouts propose — all across every wired repo. For "everything about one repo" use the Repo workspace.',
  },
  'repos-page': {
    label: 'Repos',
    short: 'Wire up repos and open per-repo workspaces.',
    long: 'List of every GitHub repo you can access. Wire up new ones, and click any wired repo to open its workspace (one rich page for that repo: in-flight, proposals, recent shipments, cost, settings).',
  },
  'intent-page': {
    label: 'Brainstorm',
    short: 'Talk to the PM agent to start new work.',
    long: 'Describe a feature, bug, or idea. The PM agent asks clarifying questions, drafts a spec, and once you approve, hands off to implementation.',
  },
  'pipeline-page': {
    label: 'Pipeline',
    short: 'Every in-flight feature by gate, across all repos.',
    long: 'Kanban-style view of features by gate. Useful when you want to see "what\'s stuck and where" rather than "what needs me right now" (Home does that).',
  },
  'proposals-page': {
    label: 'Proposals',
    short: 'Full ranked list of scout suggestions.',
    long: 'Every proposal from every scout, ranked. Snooze, dismiss, or pull into Brainstorm. Use the repo filter to scope.',
  },
  'activity-page': {
    label: 'Activity',
    short: 'Audit log of everything dev-agent did recently.',
    long: 'Append-only event log: scans, runs, gate transitions, merges, scout fires. Useful when you\'re asking "why did that happen?"',
  },
  'cost-page': {
    label: 'Cost',
    short: 'Token + workflow spend, with watchdog status.',
    long: 'Per-repo and per-feature cost charts. The cost watchdog drops implausible outliers; remaining anomalies surface here.',
  },
} as const satisfies Record<string, GlossaryEntry>;

export type TermKey = keyof typeof GLOSSARY;
```

(Long strings above are draft seeds — refine during implementation; the spec captures the *terms* we commit to surfacing.)

### `<Term>` component

New file `dashboard/components/ui/term.tsx`:

```tsx
'use client';

import * as Popover from '@radix-ui/react-popover';
import * as Tooltip from '@radix-ui/react-tooltip';
import { GLOSSARY, type TermKey } from '@/lib/glossary';

type TermProps = {
  k: TermKey;
  label?: string;                  // override display label when context wants different phrasing
  variant?: 'inline' | 'icon';     // 'inline' = underlined word; 'icon' = standalone (?) bubble
};

export function Term({ k, label, variant = 'inline' }: TermProps) { ... }
```

Behavior:
- `variant="inline"` (default): renders `<span>{label ?? GLOSSARY[k].label}</span>` with `border-b border-dotted border-accent cursor-help`.
- `variant="icon"`: renders a small `(?)` bubble (`inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-[10px]`) — use next to section headings where the term itself isn't inline.
- Hover (Radix Tooltip, delayDuration 200): shows `short`.
- Click / focus + Enter (Radix Popover): opens a card with `long`, plus `Learn more →` link if `link` is set.
- Esc closes; Tab focusable.
- If `k` is not in `GLOSSARY`: render plain text (no underline, no interactions). In dev (`process.env.NODE_ENV !== 'production'`), emit `console.warn('<Term> unknown key: ' + k)`.

---

## Page-level descriptors

### `<PageHeader>` component

New file `dashboard/components/ui/page-header.tsx`:

```tsx
import { Term, type TermKey } from '@/components/ui/term';
import type { ReactNode } from 'react';

type PageHeaderProps = {
  title: string;
  descriptor: string;        // one italic line under the H1
  helpTerm?: TermKey;        // optional: shows a (?) icon next to the title
  actions?: ReactNode;       // right-side slot for CTAs
};

export function PageHeader({ title, descriptor, helpTerm, actions }: PageHeaderProps) { ... }
```

Shape:
```
Home  (?)                                                       [Brainstorm new work →]
Everything that needs you across your wired repos, oldest first.
```

### Applied to

| Page | title | descriptor | helpTerm |
|---|---|---|---|
| `app/page.tsx` | Home | Everything that needs you across your wired repos, oldest first. | `home-page` |
| `app/repos/page.tsx` | Repos | Wire up repos and open a workspace for any one of them. | `repos-page` |
| `app/repos/[name]/page.tsx` | (repo name) | Everything about this repo on one page. | — (use breadcrumb) |
| `app/intent/page.tsx` | Brainstorm | Talk to the PM agent to start new work. | `intent-page` |
| `app/pipeline/page.tsx` | Pipeline | Every in-flight feature, grouped by gate. | `pipeline-page` |
| `app/proposals/page.tsx` | Proposals | Ranked list of scout suggestions. | `proposals-page` |
| `app/activity/page.tsx` | Activity | Audit log of everything dev-agent did recently. | `activity-page` |
| `app/cost/page.tsx` | Cost | Token and workflow spend, with watchdog status. | `cost-page` |
| `app/features/[issue]/page.tsx` | (feature title) | (state-aware: "In progress" / "Awaiting review" / "Shipped") | — |

### Band-level `(?)` on Home

Each band heading in `app/page.tsx` gets `<Term k="…" variant="icon" />` adjacent:
- "Needs you now" → `needs-you-now`
- "In motion" → `in-motion`
- "Recently shipped (last 7d)" → `recently-shipped`
- "PM proposes" → `pm-proposes`
- "Verification posture" → `verification-posture`
- "Your repos" → (no Term — self-explanatory)

The per-repo workspace gets the same treatment on its band headings, keyed identically.

---

## Component sweep: where to mount `<Term>`

For each component below, replace bare jargon strings with `<Term k="…" />`. Don't change layout, only swap the text node.

| Component | Strings to wrap |
|---|---|
| `components/verification-badges.tsx` | "Pillar 4", "Pillar 5", "Pillar 7" / "Tier-2 smoke", "EvidenceBundle" |
| `components/feature-card.tsx` | gate labels containing "Gate B" |
| `components/feature-detail.tsx` | "Gate B", "EvidenceBundle", any "Pillar N" reference |
| `components/run-progress.tsx` | "in motion" or equivalent status copy |
| `components/run-progress-drawer.tsx` | same |
| `components/pipeline-board.tsx` | gate column headers if they include "Gate B" |
| `components/inbox-item.tsx` | gate labels |
| `components/repo-card.tsx` | "wire-up", any pillar/posture text |
| `components/install-workflow-panel.tsx` | "wire-up", "Tier-2 smoke", "swarm override" |
| `components/verification-posture-strip.tsx` | "verification posture", per-pillar labels |
| `components/setup-checklist.tsx` | "wire-up" and any verification references |
| `components/help-panel.tsx` | embed full glossary inline (see below) |

**`help-panel.tsx` enhancement:** keep the 30-second pitch at top; below it, add a "Glossary" section that renders all `GLOSSARY` entries inline as a `<dl>` (term label + short, with each entry expandable to show `long`). This is the canonical reference; inline `<Term>` is the in-context lookup. No new route — the existing right-side drawer absorbs it.

---

## Files touched

### New
- `dashboard/lib/glossary.ts`
- `dashboard/components/ui/term.tsx`
- `dashboard/components/ui/page-header.tsx`
- `dashboard/components/ui/breadcrumbs.tsx`
- `dashboard/__tests__/components/term.test.tsx`
- `dashboard/__tests__/components/page-header.test.tsx`
- `dashboard/__tests__/lib/glossary.test.ts`

### Modified
- `dashboard/app/globals.css` — palette tokens (light + dark) + accent link rule
- `dashboard/components/ui/button.tsx` — add `variant="accent"`
- `dashboard/components/nav-header.tsx` — section labels, active underline, mount `<Breadcrumbs />`, split server/client
- `dashboard/components/help-panel.tsx` — embed full glossary as reference
- `dashboard/app/page.tsx` — `<PageHeader>` + band `<Term variant="icon">`
- `dashboard/app/repos/page.tsx` — `<PageHeader>`
- `dashboard/app/repos/[name]/page.tsx` — `<PageHeader>` + band `<Term variant="icon">`
- `dashboard/app/intent/page.tsx` — `<PageHeader>`
- `dashboard/app/pipeline/page.tsx` — `<PageHeader>`
- `dashboard/app/proposals/page.tsx` — `<PageHeader>`
- `dashboard/app/activity/page.tsx` — `<PageHeader>`
- `dashboard/app/cost/page.tsx` — `<PageHeader>`
- `dashboard/app/features/[issue]/page.tsx` — `<PageHeader>`
- Component sweep listed above (12 components): `verification-badges`, `feature-card`, `feature-detail`, `run-progress`, `run-progress-drawer`, `pipeline-board`, `inbox-item`, `repo-card`, `install-workflow-panel`, `verification-posture-strip`, `setup-checklist`, `help-panel`

---

## Testing

### Unit (vitest)

`__tests__/components/term.test.tsx`:
- Renders the glossary `label` when no `label` prop given.
- Renders override `label` when provided.
- Renders plain text + warns in dev when key is unknown.
- `variant="inline"` has dotted underline class; `variant="icon"` renders the `(?)` bubble.
- Click opens popover; popover shows `long`; renders `Learn more →` when `link` set.
- Esc closes popover.

`__tests__/components/page-header.test.tsx`:
- Renders title + descriptor.
- When `helpTerm` set, mounts a `<Term variant="icon">` next to the title.
- Renders `actions` slot when provided.

`__tests__/lib/glossary.test.ts`:
- Every entry has non-empty `label`, `short`, `long`.
- `short` ≤ 90 characters.
- `long` is between 80 and 600 characters (catches both stubs and bloat).
- Optional `link` is either undefined or a valid URL/path string.

### Playwright smoke

Add one spec `dashboard/__tests__/e2e/ux-brand-help.spec.ts` (or extend existing):
- Visit `/`; assert nav contains "WORK" and "INSIGHTS" labels; assert Home link has the active underline class.
- Visit `/repos`; assert breadcrumb is absent (top-level).
- Visit `/repos/<wired-name>`; assert breadcrumb shows `Home › Repos › <wired-name>`.
- Hover the "Needs you now" `(?)` icon; assert tooltip text appears.
- Click the same icon; assert popover content contains the `long` body.

### Manual visual

- Toggle OS dark mode; verify both palettes render without unreadable contrast (target WCAG AA for body text, AA-large for muted).
- Sweep every page once and confirm no raw jargon remains unwrapped (use Cmd-F for "Pillar", "Gate", "EvidenceBundle", "Tier-2", "swarm").

---

## Rollout

Single PR on a fresh branch (`feat/dashboard-ux-brand-help`). Order inside the PR:

1. **Palette tokens** — `globals.css` change. Confirms nothing looks broken under new colors.
2. **Primitives** — `term.tsx`, `page-header.tsx`, `breadcrumbs.tsx`, `button.tsx accent variant`. Unit tests for `term.tsx` and `page-header.tsx` land with the primitives.
3. **Glossary** — `lib/glossary.ts` with all draft entries. Glossary unit test lands with it.
4. **Nav rewrite** — `nav-header.tsx` split + section labels + active underline + breadcrumbs mounting.
5. **Page sweep** — mount `<PageHeader>` on the 9 top-level pages.
6. **Component sweep** — replace jargon strings with `<Term>` in the 10 listed components.
7. **Help panel update** — embed full glossary.
8. **Playwright smoke** spec.

Each step is independently runnable (the dashboard still builds and renders between them). Reviewer can spot-check progress per commit.

---

## Risks & mitigations

- **Risk:** dark-mode contrast regressions with the new teal/navy palette.
  **Mitigation:** manual visual sweep listed above; also use a contrast-check helper in the glossary test if cheap.
- **Risk:** `<Term>` overuse making body text noisy with dotted underlines everywhere.
  **Mitigation:** the component sweep table is *closed* — only the listed components/strings get wrapped in this PR. Future jargon adopts the pattern, but we don't sweep prose paragraphs.
- **Risk:** server→client split on `NavHeader` introduces a session-fetch waterfall.
  **Mitigation:** the existing pattern (server wrapper fetches session, passes to client child) avoids any extra round-trips; just a refactor of file structure.
- **Risk:** glossary text drifts from reality as pillars/gates evolve.
  **Mitigation:** glossary entries live in code (`lib/glossary.ts`), reviewed in PRs; CI test enforces non-empty bodies. Add a runbook link in CLAUDE.md noting "if you rename a pillar/gate, update glossary.ts in the same PR."
