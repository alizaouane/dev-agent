# Dashboard UX — Brand + Inline Help + Nav Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin the dashboard to Qualiency brand (navy + teal), add inline `<Term>` jargon explainers backed by a glossary single-source-of-truth, and restructure the top nav with section labels + active-page underline + breadcrumbs on inner pages.

**Architecture:** Three coordinated layers — (1) CSS color tokens swapped in `globals.css`, (2) three new UI primitives (`<Term>`, `<PageHeader>`, `<Breadcrumbs>`) backed by `lib/glossary.ts`, (3) component/page sweep that mounts the primitives without changing layout or behavior. All work lands on `feat/dashboard-ux-brand-help` as a single PR.

**Tech Stack:** Next.js 15 (App Router), React 19, TypeScript, Tailwind v4, Radix UI (tooltip + popover + dialog), vitest + @testing-library/react, Playwright.

**Spec:** [docs/superpowers/specs/2026-05-23-dashboard-ux-brand-and-help-design.md](../specs/2026-05-23-dashboard-ux-brand-and-help-design.md)

---

## Task 0: Branch + dependency

**Files:**
- Modify: `dashboard/package.json` (adds `@radix-ui/react-popover`)

- [ ] **Step 1: Create the feature branch from current HEAD**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent"
git checkout -b feat/dashboard-ux-brand-help
```

- [ ] **Step 2: Install `@radix-ui/react-popover`**

`<Term>` uses Radix Popover (click-to-open card). Radix Tooltip and Dialog are already in deps; Popover is not.

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm install @radix-ui/react-popover@^1.1.15
```

Expected: `package.json` adds `"@radix-ui/react-popover": "^1.1.15"` under `dependencies`. `package-lock.json` updates.

- [ ] **Step 3: Verify build still works**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm run typecheck
```

Expected: exit 0, no errors.

- [ ] **Step 4: Commit**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent"
git add dashboard/package.json dashboard/package-lock.json
git commit -m "chore(dashboard): add @radix-ui/react-popover for <Term> popovers"
```

---

## Task 1: Brand palette tokens

**Files:**
- Modify: `dashboard/app/globals.css` (full rewrite of `@layer base` block)

- [ ] **Step 1: Replace the `@layer base` block in `globals.css`**

Open [dashboard/app/globals.css](../../dashboard/app/globals.css) and replace the entire `@layer base { ... }` block with:

```css
@layer base {
  :root {
    /* Light mode — Qualiency-aligned */
    --background: 0 0% 100%;
    --foreground: 220 25% 15%;
    --card: 0 0% 100%;
    --card-foreground: 220 25% 15%;
    --popover: 0 0% 100%;
    --popover-foreground: 220 25% 15%;
    --primary: 220 30% 18%;
    --primary-foreground: 0 0% 100%;
    --secondary: 210 17% 97%;
    --secondary-foreground: 220 25% 15%;
    --muted: 210 14% 93%;
    --muted-foreground: 220 10% 40%;
    --accent: 180 75% 40%;
    --accent-foreground: 0 0% 100%;
    --destructive: 0 75% 50%;
    --destructive-foreground: 0 0% 100%;
    --border: 220 14% 90%;
    --input: 220 14% 90%;
    --ring: 180 75% 40%;
    --radius: 0.5rem;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --background: 220 25% 10%;
      --foreground: 210 17% 95%;
      --card: 220 25% 12%;
      --card-foreground: 210 17% 95%;
      --popover: 220 25% 12%;
      --popover-foreground: 210 17% 95%;
      --primary: 210 17% 95%;
      --primary-foreground: 220 30% 18%;
      --secondary: 220 20% 16%;
      --secondary-foreground: 210 17% 95%;
      --muted: 220 18% 18%;
      --muted-foreground: 210 14% 65%;
      --accent: 180 70% 50%;
      --accent-foreground: 220 25% 12%;
      --destructive: 0 65% 45%;
      --destructive-foreground: 210 17% 95%;
      --border: 220 18% 22%;
      --input: 220 18% 22%;
      --ring: 180 70% 50%;
    }
  }
}

@layer base {
  /* Inline links pick up the accent (teal) color by default.
     Anchors that are styled as buttons (have a bg-* class) opt out automatically.
     Components that intentionally need neutral link color set `data-no-style`. */
  a:not([class*="bg-"]):not([data-no-style]) {
    color: hsl(var(--accent));
  }
  a:not([class*="bg-"]):not([data-no-style]):hover {
    text-decoration: underline;
  }
}
```

- [ ] **Step 2: Boot the dev server and visually sanity-check**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm run dev
```

Open `http://localhost:3000` in a browser. Expected:
- Background still white (light mode) or dark navy (dark mode).
- Text reads navy on white (light) / off-white on navy (dark).
- Inline links (e.g., "see all" on Home) are now teal.
- Primary buttons (e.g., "Brainstorm new work") are navy fill — unchanged in shape, slightly different tone.
- No text becomes illegible.

Kill the dev server (Ctrl-C) once verified.

- [ ] **Step 3: Run existing tests**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm test
```

Expected: all existing tests pass (no test depends on specific color values).

- [ ] **Step 4: Commit**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent"
git add dashboard/app/globals.css
git commit -m "feat(dashboard): swap palette to Qualiency tokens (navy + teal)"
```

---

## Task 2: Add `accent` button variant

**Files:**
- Modify: `dashboard/components/ui/button.tsx`

- [ ] **Step 1: Add `accent` to the `variant` map in `buttonVariants`**

Open [dashboard/components/ui/button.tsx](../../dashboard/components/ui/button.tsx). Inside the `variants.variant` object (between `secondary` and `ghost`), add:

```ts
accent:
  "bg-accent text-accent-foreground shadow hover:bg-accent/90",
```

The block should now contain `default`, `destructive`, `outline`, `secondary`, `accent`, `ghost`, `link` in that order.

- [ ] **Step 2: Type-check**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent"
git add dashboard/components/ui/button.tsx
git commit -m "feat(dashboard): add Button variant=\"accent\" (teal CTA)"
```

---

## Task 3: Glossary single source of truth

**Files:**
- Create: `dashboard/lib/glossary.ts`
- Create: `dashboard/__tests__/lib/glossary.test.ts`

- [ ] **Step 1: Write the failing test**

Create `dashboard/__tests__/lib/glossary.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { GLOSSARY } from '@/lib/glossary';

describe('GLOSSARY', () => {
  it('has at least one entry', () => {
    expect(Object.keys(GLOSSARY).length).toBeGreaterThan(0);
  });

  it('every entry has non-empty label, short, long', () => {
    for (const [key, entry] of Object.entries(GLOSSARY)) {
      expect(entry.label, `${key}.label`).toBeTruthy();
      expect(entry.short, `${key}.short`).toBeTruthy();
      expect(entry.long, `${key}.long`).toBeTruthy();
    }
  });

  it('every `short` is <= 90 characters', () => {
    for (const [key, entry] of Object.entries(GLOSSARY)) {
      expect(entry.short.length, `${key}.short length`).toBeLessThanOrEqual(90);
    }
  });

  it('every `long` is between 80 and 600 characters', () => {
    for (const [key, entry] of Object.entries(GLOSSARY)) {
      expect(entry.long.length, `${key}.long length`).toBeGreaterThanOrEqual(80);
      expect(entry.long.length, `${key}.long length`).toBeLessThanOrEqual(600);
    }
  });

  it('every optional `link` is a non-empty string when present', () => {
    for (const [key, entry] of Object.entries(GLOSSARY)) {
      if (entry.link !== undefined) {
        expect(entry.link, `${key}.link`).toMatch(/^.+/);
      }
    }
  });

  it('contains the required v1 terms', () => {
    const required = [
      'gate-b', 'pillar-4', 'pillar-5', 'tier2-smoke', 'evidence-bundle',
      'scout', 'swarm-override', 'wire-up', 'pm-agent',
      'needs-you-now', 'in-motion', 'verification-posture',
      'recently-shipped', 'pm-proposes',
      'home-page', 'repos-page', 'intent-page', 'pipeline-page',
      'proposals-page', 'activity-page', 'cost-page',
    ];
    for (const k of required) {
      expect(GLOSSARY).toHaveProperty(k);
    }
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm test -- __tests__/lib/glossary.test.ts
```

Expected: FAIL — `Cannot find module '@/lib/glossary'`.

- [ ] **Step 3: Create the glossary file**

Create `dashboard/lib/glossary.ts`:

```ts
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
    long: 'Proposals collected by the scouts (Sentry, GitHub, drift). Top items appear on Home; the full ranked list is on the Proposals page.',
  },
  'home-page': {
    label: 'Home',
    short: 'Cross-repo command center.',
    long: 'Everything that needs you, what\'s in motion, what shipped, and what your scouts propose — all across every wired repo. For "everything about one repo" use the Repo workspace instead.',
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
    long: 'Kanban-style view of features by gate. Useful when you want to see "what\'s stuck and where" rather than "what needs me right now" — Home answers the latter.',
  },
  'proposals-page': {
    label: 'Proposals',
    short: 'Full ranked list of scout suggestions.',
    long: 'Every proposal from every scout, ranked. Snooze, dismiss, or pull into Brainstorm. Use the repo filter to scope to one repo.',
  },
  'activity-page': {
    label: 'Activity',
    short: 'Audit log of everything dev-agent did recently.',
    long: 'Append-only event log: scans, runs, gate transitions, merges, scout fires. Useful when you\'re asking "why did that happen?"',
  },
  'cost-page': {
    label: 'Cost',
    short: 'Token + workflow spend, with watchdog status.',
    long: 'Per-repo and per-feature cost charts. The cost watchdog drops implausible outliers; remaining anomalies surface here for review.',
  },
} as const satisfies Record<string, GlossaryEntry>;

export type TermKey = keyof typeof GLOSSARY;
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm test -- __tests__/lib/glossary.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent"
git add dashboard/lib/glossary.ts dashboard/__tests__/lib/glossary.test.ts
git commit -m "feat(dashboard): glossary single-source-of-truth for jargon terms"
```

---

## Task 4: `<Term>` primitive

**Files:**
- Create: `dashboard/components/ui/term.tsx`
- Create: `dashboard/__tests__/components/term.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `dashboard/__tests__/components/term.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Term } from '@/components/ui/term';

describe('<Term>', () => {
  it('renders the glossary label when no label prop is given', () => {
    render(<Term k="gate-b" />);
    expect(screen.getByText('Gate B')).toBeInTheDocument();
  });

  it('renders the override label when provided', () => {
    render(<Term k="gate-b" label="Gate B review" />);
    expect(screen.getByText('Gate B review')).toBeInTheDocument();
  });

  it('applies dotted-underline styling for variant="inline" (default)', () => {
    render(<Term k="gate-b" />);
    const el = screen.getByText('Gate B');
    expect(el.className).toContain('border-dotted');
    expect(el.className).toContain('cursor-help');
  });

  it('renders a (?) bubble for variant="icon"', () => {
    render(<Term k="needs-you-now" variant="icon" />);
    // The (?) bubble is a button so it can be a popover trigger
    const trigger = screen.getByRole('button', { name: /what is needs you now/i });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveTextContent('?');
  });

  it('renders plain text and warns in dev when the key is unknown', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // @ts-expect-error — intentionally unknown key for the test
    render(<Term k="not-a-real-key" label="fallback" />);
    expect(screen.getByText('fallback')).toBeInTheDocument();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not-a-real-key'));
    warn.mockRestore();
  });

  it('opens a popover with the long body when clicked (variant=inline)', () => {
    render(<Term k="gate-b" />);
    fireEvent.click(screen.getByText('Gate B'));
    // Popover content is portaled but is in the same document under jsdom.
    expect(
      screen.getByText(/human review checkpoint/i),
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm test -- __tests__/components/term.test.tsx
```

Expected: FAIL — `Cannot find module '@/components/ui/term'`.

- [ ] **Step 3: Create the component**

Create `dashboard/components/ui/term.tsx`:

```tsx
'use client';

import { useEffect } from 'react';
import * as Popover from '@radix-ui/react-popover';
import * as Tooltip from '@radix-ui/react-tooltip';
import { GLOSSARY, type TermKey } from '@/lib/glossary';
import { cn } from '@/lib/utils';

type TermProps = {
  /** Glossary key — must exist in GLOSSARY. */
  k: TermKey;
  /** Override display label (defaults to GLOSSARY[k].label). */
  label?: string;
  /** Render mode. `inline` (default) underlines the label in-flow.
   *  `icon` renders a small (?) bubble — use next to section headings. */
  variant?: 'inline' | 'icon';
  /** Extra classes appended to the trigger. */
  className?: string;
};

export function Term({ k, label, variant = 'inline', className }: TermProps) {
  const entry = GLOSSARY[k];

  useEffect(() => {
    if (!entry && process.env.NODE_ENV !== 'production') {
      console.warn(`<Term> unknown key: ${k}`);
    }
  }, [entry, k]);

  if (!entry) {
    return <span className={className}>{label ?? String(k)}</span>;
  }

  const displayLabel = label ?? entry.label;

  const triggerClass =
    variant === 'inline'
      ? cn(
          'border-b border-dotted border-accent cursor-help text-inherit',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm',
          className,
        )
      : cn(
          'inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-[10px] leading-none text-muted-foreground hover:border-accent hover:text-accent',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          className,
        );

  const triggerEl =
    variant === 'inline' ? (
      <span tabIndex={0}>{displayLabel}</span>
    ) : (
      <span aria-hidden="true">?</span>
    );

  const ariaLabel =
    variant === 'icon' ? `What is ${entry.label}?` : entry.label;

  return (
    <Tooltip.Provider delayDuration={200}>
      <Popover.Root>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <Popover.Trigger
              type="button"
              className={triggerClass}
              aria-label={ariaLabel}
            >
              {triggerEl}
            </Popover.Trigger>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              side="top"
              sideOffset={6}
              className="z-50 max-w-xs rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow"
            >
              {entry.short}
              <Tooltip.Arrow className="fill-popover" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
        <Popover.Portal>
          <Popover.Content
            side="bottom"
            align="start"
            sideOffset={6}
            className="z-50 w-80 rounded-md border border-border bg-popover p-4 text-sm text-popover-foreground shadow-lg"
          >
            <div className="mb-1 font-semibold">{entry.label}</div>
            <p className="text-muted-foreground">{entry.long}</p>
            {entry.link && (
              <a
                href={entry.link}
                className="mt-2 inline-block text-xs font-medium text-accent hover:underline"
                target={entry.link.startsWith('http') ? '_blank' : undefined}
                rel={entry.link.startsWith('http') ? 'noopener noreferrer' : undefined}
              >
                Learn more →
              </a>
            )}
            <Popover.Arrow className="fill-popover" />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </Tooltip.Provider>
  );
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm test -- __tests__/components/term.test.tsx
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent"
git add dashboard/components/ui/term.tsx dashboard/__tests__/components/term.test.tsx
git commit -m "feat(dashboard): <Term> primitive (hover tooltip + click popover)"
```

---

## Task 5: `<PageHeader>` primitive

**Files:**
- Create: `dashboard/components/ui/page-header.tsx`
- Create: `dashboard/__tests__/components/page-header.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `dashboard/__tests__/components/page-header.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageHeader } from '@/components/ui/page-header';

describe('<PageHeader>', () => {
  it('renders the title as an h1 and the descriptor below it', () => {
    render(<PageHeader title="Home" descriptor="What needs you, across all repos." />);
    expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    expect(screen.getByText('What needs you, across all repos.')).toBeInTheDocument();
  });

  it('mounts a Term (?) bubble next to the title when helpTerm is set', () => {
    render(<PageHeader title="Home" descriptor="d" helpTerm="home-page" />);
    expect(screen.getByRole('button', { name: /what is home/i })).toBeInTheDocument();
  });

  it('omits the (?) bubble when helpTerm is not set', () => {
    render(<PageHeader title="Home" descriptor="d" />);
    expect(screen.queryByRole('button', { name: /what is/i })).toBeNull();
  });

  it('renders actions in the right-side slot', () => {
    render(
      <PageHeader title="Home" descriptor="d" actions={<button>Do thing</button>} />,
    );
    expect(screen.getByRole('button', { name: 'Do thing' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm test -- __tests__/components/page-header.test.tsx
```

Expected: FAIL — `Cannot find module '@/components/ui/page-header'`.

- [ ] **Step 3: Create the component**

Create `dashboard/components/ui/page-header.tsx`:

```tsx
import type { ReactNode } from 'react';
import { Term, type TermKey } from '@/components/ui/term';

type PageHeaderProps = {
  title: string;
  descriptor: string;
  /** Optional: shows a (?) bubble next to the title that opens the term's popover. */
  helpTerm?: TermKey;
  /** Right-side slot for primary CTAs. */
  actions?: ReactNode;
};

export function PageHeader({ title, descriptor, helpTerm, actions }: PageHeaderProps) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-2xl">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {helpTerm && <Term k={helpTerm} variant="icon" />}
        </div>
        <p className="mt-1 text-sm italic text-muted-foreground">{descriptor}</p>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm test -- __tests__/components/page-header.test.tsx
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent"
git add dashboard/components/ui/page-header.tsx dashboard/__tests__/components/page-header.test.tsx
git commit -m "feat(dashboard): <PageHeader> with title, descriptor, helpTerm, actions"
```

---

## Task 6: `<Breadcrumbs>` primitive

**Files:**
- Create: `dashboard/components/ui/breadcrumbs.tsx`
- Create: `dashboard/__tests__/components/breadcrumbs.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `dashboard/__tests__/components/breadcrumbs.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Breadcrumbs, crumbsForPath } from '@/components/ui/breadcrumbs';

describe('<Breadcrumbs>', () => {
  it('renders nothing when crumbs is empty', () => {
    const { container } = render(<Breadcrumbs crumbs={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders intermediate crumbs as links and the last as plain text', () => {
    render(
      <Breadcrumbs
        crumbs={[
          { label: 'Home', href: '/' },
          { label: 'Repos', href: '/repos' },
          { label: 'qualiency/web' },
        ]}
      />,
    );
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Repos' })).toBeInTheDocument();
    // Last crumb is current page — no link
    expect(screen.queryByRole('link', { name: 'qualiency/web' })).toBeNull();
    expect(screen.getByText('qualiency/web')).toBeInTheDocument();
  });
});

describe('crumbsForPath', () => {
  it('returns [] for top-level routes', () => {
    expect(crumbsForPath('/', null)).toEqual([]);
    expect(crumbsForPath('/repos', null)).toEqual([]);
    expect(crumbsForPath('/intent', null)).toEqual([]);
    expect(crumbsForPath('/pipeline', null)).toEqual([]);
    expect(crumbsForPath('/proposals', null)).toEqual([]);
    expect(crumbsForPath('/activity', null)).toEqual([]);
    expect(crumbsForPath('/cost', null)).toEqual([]);
  });

  it('builds Home › Repos › :name for /repos/:name', () => {
    expect(crumbsForPath('/repos/qualiency-web', null)).toEqual([
      { label: 'Home', href: '/' },
      { label: 'Repos', href: '/repos' },
      { label: 'qualiency-web' },
    ]);
  });

  it('builds Home › Features › #:issue for /features/:issue', () => {
    expect(crumbsForPath('/features/142', null)).toEqual([
      { label: 'Home', href: '/' },
      { label: 'Features', href: '/pipeline' },
      { label: '#142' },
    ]);
  });

  it('enriches /intent with repo from query string when present', () => {
    expect(crumbsForPath('/intent', 'qualiency-web')).toEqual([
      { label: 'Home', href: '/' },
      { label: 'Brainstorm', href: '/intent' },
      { label: 'qualiency-web' },
    ]);
  });

  it('returns [] for /intent without a repo query', () => {
    expect(crumbsForPath('/intent', null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm test -- __tests__/components/breadcrumbs.test.tsx
```

Expected: FAIL — `Cannot find module '@/components/ui/breadcrumbs'`.

- [ ] **Step 3: Create the component**

Create `dashboard/components/ui/breadcrumbs.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

export type Crumb = { label: string; href?: string };

/** Pure function — derives the crumb trail for a given pathname.
 *  Returns [] for routes that should render no breadcrumb. */
export function crumbsForPath(pathname: string, repoQuery: string | null): Crumb[] {
  // Top-level routes: no breadcrumb
  const TOP_LEVEL = new Set([
    '/',
    '/repos',
    '/pipeline',
    '/proposals',
    '/activity',
    '/cost',
  ]);
  if (TOP_LEVEL.has(pathname)) return [];

  // /intent — only render a breadcrumb if scoped to a repo via ?repo=
  if (pathname === '/intent') {
    if (!repoQuery) return [];
    return [
      { label: 'Home', href: '/' },
      { label: 'Brainstorm', href: '/intent' },
      { label: repoQuery },
    ];
  }

  // /repos/:name
  const repoMatch = pathname.match(/^\/repos\/([^/]+)$/);
  if (repoMatch) {
    return [
      { label: 'Home', href: '/' },
      { label: 'Repos', href: '/repos' },
      { label: decodeURIComponent(repoMatch[1]) },
    ];
  }

  // /features/:issue
  const featureMatch = pathname.match(/^\/features\/([^/]+)$/);
  if (featureMatch) {
    return [
      { label: 'Home', href: '/' },
      { label: 'Features', href: '/pipeline' },
      { label: `#${featureMatch[1]}` },
    ];
  }

  return [];
}

export function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className="border-b border-border bg-secondary/40">
      <ol className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <li key={`${c.label}-${i}`} className="flex items-center gap-2">
              {c.href && !isLast ? (
                <Link href={c.href} data-no-style className="hover:text-foreground">
                  {c.label}
                </Link>
              ) : (
                <span className="text-foreground">{c.label}</span>
              )}
              {!isLast && <span aria-hidden>›</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Client convenience: auto-builds crumbs from the current URL. */
export function AutoBreadcrumbs() {
  const pathname = usePathname() ?? '/';
  const search = useSearchParams();
  const repo = search?.get('repo') ?? null;
  return <Breadcrumbs crumbs={crumbsForPath(pathname, repo)} />;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm test -- __tests__/components/breadcrumbs.test.tsx
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent"
git add dashboard/components/ui/breadcrumbs.tsx dashboard/__tests__/components/breadcrumbs.test.tsx
git commit -m "feat(dashboard): <Breadcrumbs> + crumbsForPath route mapping"
```

---

## Task 7: Restructure `NavHeader` (section labels + active underline)

**Files:**
- Modify: `dashboard/components/nav-header.tsx` (replace contents)
- Modify: `dashboard/__tests__/components/nav-header.test.tsx` (update assertions)

- [ ] **Step 1: Update the existing nav-header test**

Open `dashboard/__tests__/components/nav-header.test.tsx` and replace contents with:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NavLinks } from '@/components/nav-header';

vi.mock('next/navigation', () => ({
  usePathname: () => '/repos',
}));

describe('<NavLinks>', () => {
  it('renders 3 primary links: Home, Repos, Brainstorm', () => {
    render(<NavLinks />);
    expect(screen.getByRole('link', { name: /^Home$/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Repos$/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Brainstorm$/ })).toBeInTheDocument();
  });

  it('renders secondary links under WORK and INSIGHTS groups', () => {
    render(<NavLinks />);
    for (const label of ['Proposals', 'Pipeline', 'Activity', 'Cost']) {
      expect(screen.getByRole('link', { name: new RegExp(`^${label}$`) })).toBeInTheDocument();
    }
    expect(screen.getByText(/^WORK$/)).toBeInTheDocument();
    expect(screen.getByText(/^INSIGHTS$/)).toBeInTheDocument();
  });

  it('marks the active link based on pathname', () => {
    render(<NavLinks />);
    const reposLink = screen.getByRole('link', { name: /^Repos$/ });
    expect(reposLink).toHaveAttribute('aria-current', 'page');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm test -- __tests__/components/nav-header.test.tsx
```

Expected: FAIL — `WORK`/`INSIGHTS` group labels not found; `aria-current` not set.

- [ ] **Step 3: Replace `nav-header.tsx` contents**

Open `dashboard/components/nav-header.tsx` and replace with:

```tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { HelpPanel } from '@/components/help-panel';
import { AutoBreadcrumbs } from '@/components/ui/breadcrumbs';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

const PRIMARY = [
  { href: '/', label: 'Home' },
  { href: '/repos', label: 'Repos' },
  { href: '/intent', label: 'Brainstorm' },
];

const WORK = [
  { href: '/pipeline', label: 'Pipeline' },
  { href: '/proposals', label: 'Proposals' },
];

const INSIGHTS = [
  { href: '/activity', label: 'Activity' },
  { href: '/cost', label: 'Cost' },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(href + '/');
}

function NavLink({
  href,
  label,
  pathname,
  emphasis = 'primary',
}: {
  href: string;
  label: string;
  pathname: string;
  emphasis?: 'primary' | 'secondary';
}) {
  const active = isActive(pathname, href);
  return (
    <Link
      href={href}
      data-no-style
      aria-current={active ? 'page' : undefined}
      className={cn(
        'inline-block border-b-2 pb-1 transition-colors',
        active
          ? 'border-accent font-medium text-foreground'
          : 'border-transparent hover:text-foreground',
        emphasis === 'primary' ? 'text-foreground' : 'text-muted-foreground',
      )}
    >
      {label}
    </Link>
  );
}

export function NavLinks() {
  const pathname = usePathname() ?? '/';
  return (
    <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      {PRIMARY.map((l) => (
        <NavLink key={l.href} {...l} pathname={pathname} emphasis="primary" />
      ))}
      <span aria-hidden className="hidden text-border sm:inline">|</span>
      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">WORK</span>
      {WORK.map((l) => (
        <NavLink key={l.href} {...l} pathname={pathname} emphasis="secondary" />
      ))}
      <span className="ml-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">INSIGHTS</span>
      {INSIGHTS.map((l) => (
        <NavLink key={l.href} {...l} pathname={pathname} emphasis="secondary" />
      ))}
    </nav>
  );
}

/** Client wrapper for nav body — server wrapper passes the auth bits in. */
export function NavHeaderShell({
  username,
  signOutForm,
}: {
  username: string | null;
  signOutForm: ReactNode;
}) {
  return (
    <header className="border-b border-border bg-background">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
        <Link href="/" data-no-style className="font-semibold text-foreground">
          dev-agent
        </Link>
        <div className="hidden sm:block">
          <NavLinks />
        </div>
        <div className="flex items-center gap-3">
          <Button asChild variant="accent" size="sm">
            <Link href="/intent" data-no-style>
              Brainstorm new work
            </Link>
          </Button>
          <HelpPanel />
          {username && signOutForm}
        </div>
      </div>
      <AutoBreadcrumbs />
    </header>
  );
}
```

- [ ] **Step 4: Update the server wrapper that consumed the old `NavHeader`**

The old `NavHeader` was an async server component. Split it into a thin server file that does session lookup and renders `NavHeaderShell`. Replace the rest of `nav-header.tsx` is now client. Create a new server file `dashboard/components/nav-header.server.tsx`:

```tsx
import { Button } from '@/components/ui/button';
import { auth, signOut } from '@/lib/auth';
import { NavHeaderShell } from '@/components/nav-header';

export async function NavHeader() {
  const session = await auth();
  const signOutForm = session?.user ? (
    <form
      action={async () => {
        'use server';
        await signOut({ redirectTo: '/auth/signin' });
      }}
    >
      <Button type="submit" variant="ghost" size="sm">
        @{session.user.username}
      </Button>
    </form>
  ) : null;
  return <NavHeaderShell username={session?.user?.username ?? null} signOutForm={signOutForm} />;
}
```

- [ ] **Step 5: Update the import in `app/layout.tsx`**

The layout currently imports `NavHeader` from `@/components/nav-header`. After the split, it lives in `nav-header.server`. Open `dashboard/app/layout.tsx` and change:

```tsx
import { NavHeader } from '@/components/nav-header';
```

to:

```tsx
import { NavHeader } from '@/components/nav-header.server';
```

- [ ] **Step 6: Run all tests**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm test
```

Expected: all tests pass, including the updated nav-header test.

- [ ] **Step 7: Boot dev server and visually verify**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm run dev
```

Open `http://localhost:3000`. Expected:
- Nav shows: `dev-agent  Home · Repos · Brainstorm  |  WORK  Pipeline · Proposals  INSIGHTS  Activity · Cost   [Brainstorm new work]  (?)  @user`.
- Home link is teal-underlined.
- Click Repos → underline moves to Repos.
- Click a wired repo → breadcrumb appears below header: `Home › Repos › <name>`.

Kill dev server.

- [ ] **Step 8: Commit**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent"
git add dashboard/components/nav-header.tsx \
        dashboard/components/nav-header.server.tsx \
        dashboard/app/layout.tsx \
        dashboard/__tests__/components/nav-header.test.tsx
git commit -m "feat(dashboard): nav — section labels, active underline, breadcrumbs"
```

---

## Task 8: Mount `<PageHeader>` on all top-level pages

**Files:**
- Modify: `dashboard/app/page.tsx`
- Modify: `dashboard/app/repos/page.tsx`
- Modify: `dashboard/app/repos/[name]/page.tsx`
- Modify: `dashboard/app/intent/page.tsx`
- Modify: `dashboard/app/pipeline/page.tsx`
- Modify: `dashboard/app/proposals/page.tsx`
- Modify: `dashboard/app/activity/page.tsx`
- Modify: `dashboard/app/cost/page.tsx`
- Modify: `dashboard/app/features/[issue]/page.tsx`

- [ ] **Step 1: Replace the Home hero block in `app/page.tsx`**

Open `dashboard/app/page.tsx`. Locate the `{/* Band 1 — Hero */}` section (around lines 44-55) and replace it with:

```tsx
{/* Band 1 — Hero */}
<PageHeader
  title="Home"
  descriptor={
    bands.hero.state === 'wired'
      ? bands.hero.message
      : 'Everything that needs you across your wired repos.'
  }
  helpTerm="home-page"
  actions={
    <Link href="/intent" data-no-style>
      <Button variant="accent" size="lg">Brainstorm new work</Button>
    </Link>
  }
/>
```

At the top of the file, add the import:

```tsx
import { PageHeader } from '@/components/ui/page-header';
```

(Keep the existing `Link` and `Button` imports.)

- [ ] **Step 2: Add `<PageHeader>` to `app/repos/page.tsx`**

Open `dashboard/app/repos/page.tsx`. Add the import at the top:

```tsx
import { PageHeader } from '@/components/ui/page-header';
```

Replace the current `<h1>` (or top heading line) with:

```tsx
<PageHeader
  title="Repos"
  descriptor="Wire up repos and open a workspace for any one of them."
  helpTerm="repos-page"
/>
```

- [ ] **Step 3: Add `<PageHeader>` to `app/repos/[name]/page.tsx`**

Open `dashboard/app/repos/[name]/page.tsx`. The existing file decodes the route param into a `const name` variable at the top of `RepoPage`. Add the import:

```tsx
import { PageHeader } from '@/components/ui/page-header';
```

Replace the page's existing top heading with:

```tsx
<PageHeader
  title={name}
  descriptor="Everything about this repo on one page."
/>
```

- [ ] **Step 4: Add `<PageHeader>` to `app/intent/page.tsx`**

Open `dashboard/app/intent/page.tsx`. Add import, then replace top heading:

```tsx
<PageHeader
  title="Brainstorm"
  descriptor="Talk to the PM agent to start new work."
  helpTerm="intent-page"
/>
```

- [ ] **Step 5: Add `<PageHeader>` to `app/pipeline/page.tsx`**

Open `dashboard/app/pipeline/page.tsx`. Add import, then replace top heading:

```tsx
<PageHeader
  title="Pipeline"
  descriptor="Every in-flight feature, grouped by gate."
  helpTerm="pipeline-page"
/>
```

- [ ] **Step 6: Add `<PageHeader>` to `app/proposals/page.tsx`**

Open `dashboard/app/proposals/page.tsx`. Add import, then replace top heading:

```tsx
<PageHeader
  title="Proposals"
  descriptor="Ranked list of scout suggestions."
  helpTerm="proposals-page"
/>
```

- [ ] **Step 7: Add `<PageHeader>` to `app/activity/page.tsx`**

Open `dashboard/app/activity/page.tsx`. Add import, then replace top heading:

```tsx
<PageHeader
  title="Activity"
  descriptor="Audit log of everything dev-agent did recently."
  helpTerm="activity-page"
/>
```

- [ ] **Step 8: Add `<PageHeader>` to `app/cost/page.tsx`**

Open `dashboard/app/cost/page.tsx`. Add import, then replace top heading:

```tsx
<PageHeader
  title="Cost"
  descriptor="Token and workflow spend, with watchdog status."
  helpTerm="cost-page"
/>
```

- [ ] **Step 9: Add `<PageHeader>` to `app/features/[issue]/page.tsx`**

Open `dashboard/app/features/[issue]/page.tsx`. The existing file fetches `issueData` (the GitHub issue) and derives `stateLabel` (a string like `"state:gate-b"` from issue labels). Add the import, then replace the top heading with:

```tsx
<PageHeader
  title={issueData.title}
  descriptor={
    issueData.state === 'closed'
      ? 'Shipped — verification chips below show what was green at merge.'
      : stateLabel?.includes('gate-b')
        ? 'Awaiting your review at Gate B.'
        : 'In progress — current step shown below.'
  }
/>
```

If `issueData.title` is empty for any reason, fall back to `#${issue_number}` — `title={issueData.title || \`#${issue_number}\`}`.

- [ ] **Step 10: Type-check and run all tests**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm run typecheck && npm test
```

Expected: exit 0, all tests pass.

- [ ] **Step 11: Boot dev server and visually verify**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm run dev
```

Walk through each page: Home, Repos, /repos/[any wired], Intent, Pipeline, Proposals, Activity, Cost, and a feature page. Expected on each: italic descriptor sits under the H1; pages that have `helpTerm` show a small `(?)` bubble next to the title that opens the term popover on click.

Kill dev server.

- [ ] **Step 12: Commit**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent"
git add dashboard/app/page.tsx \
        dashboard/app/repos/page.tsx \
        dashboard/app/repos/\[name\]/page.tsx \
        dashboard/app/intent/page.tsx \
        dashboard/app/pipeline/page.tsx \
        dashboard/app/proposals/page.tsx \
        dashboard/app/activity/page.tsx \
        dashboard/app/cost/page.tsx \
        dashboard/app/features/\[issue\]/page.tsx
git commit -m "feat(dashboard): mount <PageHeader> on all top-level pages"
```

---

## Task 9: Mount band `<Term variant="icon">` on Home and Repo workspace

**Files:**
- Modify: `dashboard/app/page.tsx`
- Modify: `dashboard/app/repos/[name]/page.tsx`

- [ ] **Step 1: Add `<Term variant="icon">` to each band heading in `app/page.tsx`**

Open `dashboard/app/page.tsx`. At the top, add the import (next to the `PageHeader` import from Task 8):

```tsx
import { Term } from '@/components/ui/term';
```

Then replace each band's `<h2>` line as follows. Pattern:

```tsx
<h2 className="mb-3 text-lg font-semibold">Needs you now</h2>
```

becomes:

```tsx
<h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
  Needs you now
  <Term k="needs-you-now" variant="icon" />
</h2>
```

Apply this to every band heading:

| Band heading text | Term key |
|---|---|
| `Needs you now` | `needs-you-now` |
| `In motion` | `in-motion` |
| `Recently shipped (last 7d)` | `recently-shipped` |
| `PM proposes` | `pm-proposes` |
| `Verification posture` | `verification-posture` |

"Your repos" gets no `<Term>` (self-explanatory, per spec).

- [ ] **Step 2: Add band `<Term>` icons to `app/repos/[name]/page.tsx`**

Open `dashboard/app/repos/[name]/page.tsx`. Add the same import. For each section heading in the repo workspace that matches a glossary key, wrap with the same pattern. At minimum, look for headings containing `In motion`, `Recently shipped`, `Proposals`, `Verification posture` — and apply the same `<Term k="..." variant="icon" />` adjacent to each.

If a heading on the page doesn't have a glossary key (e.g., "Settings", "Cost (this repo)"), leave it alone — don't invent keys for this task.

- [ ] **Step 3: Type-check**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 4: Boot dev server and visually verify**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm run dev
```

On Home, every band heading except "Your repos" has a `(?)` bubble next to it. Hover shows the tooltip short. Click opens the popover with the long body. Same on the Repo workspace for the matching headings. Kill dev server.

- [ ] **Step 5: Commit**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent"
git add dashboard/app/page.tsx dashboard/app/repos/\[name\]/page.tsx
git commit -m "feat(dashboard): band (?) icons on Home + Repo workspace"
```

---

## Task 10: Sweep `<Term>` into verification components

**Files:**
- Modify: `dashboard/components/verification-badges.tsx`
- Modify: `dashboard/components/verification-posture-strip.tsx`

- [ ] **Step 1: Wrap jargon in `verification-badges.tsx`**

Open `dashboard/components/verification-badges.tsx`. Add the import:

```tsx
import { Term } from '@/components/ui/term';
```

Find any literal strings that match a glossary term and wrap them. Specifically:
- Any badge label literally containing `"Pillar 4"` → render as `<Term k="pillar-4" />` inside the badge.
- Any badge containing `"Pillar 5"` → `<Term k="pillar-5" />`.
- Any badge containing `"Tier-2 smoke"` or `"Pillar 7"` → `<Term k="tier2-smoke" />`.
- Any "EvidenceBundle" reference → `<Term k="evidence-bundle" />`.

If labels are looked up from a `BADGE_LABELS` map or similar, do the swap at the render site (where the label is placed into JSX), not in the data map.

If a badge string is constructed (`"Pillar " + n`), keep the construction but wrap the result conditionally:

```tsx
{label === 'Pillar 4' ? <Term k="pillar-4" label={label} /> : label}
```

- [ ] **Step 2: Wrap jargon in `verification-posture-strip.tsx`**

Open `dashboard/components/verification-posture-strip.tsx`. Add the import, then:
- Replace any per-pillar labels with the matching `<Term>` (same keys as Step 1).
- If "verification posture" appears as a label/heading inside the component, wrap with `<Term k="verification-posture" />`.

- [ ] **Step 3: Run existing verification tests**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm test -- __tests__/components/verification-badges.test.tsx __tests__/components/verification-posture-strip.test.tsx
```

If a test fails because it asserts an exact text node (e.g., `getByText('Pillar 4')`) — that text is still rendered by `<Term>`'s inline span, so the test should still pass. If a test asserts on the *element type* (e.g., expects a bare `<span>` not a button), update the test to use `getByText` which is element-agnostic.

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent"
git add dashboard/components/verification-badges.tsx dashboard/components/verification-posture-strip.tsx
git commit -m "feat(dashboard): <Term> in verification badges + posture strip"
```

---

## Task 11: Sweep `<Term>` into feature + run components

**Files:**
- Modify: `dashboard/components/feature-card.tsx`
- Modify: `dashboard/components/feature-detail.tsx`
- Modify: `dashboard/components/run-progress.tsx`
- Modify: `dashboard/components/run-progress-drawer.tsx`
- Modify: `dashboard/components/pipeline-board.tsx`
- Modify: `dashboard/components/inbox-item.tsx`

- [ ] **Step 1: Wrap gate labels in `feature-card.tsx`**

Open `dashboard/components/feature-card.tsx`. Add the `Term` import. The badge currently renders `item.state.replace('state:', '')`. If the resulting string contains `"gate-b"` or `"Gate B"`, wrap it:

```tsx
const stateLabel = item.state.replace('state:', '');
// ...
<Badge variant="secondary">
  {/^gate[\s-]?b$/i.test(stateLabel)
    ? <Term k="gate-b" label={stateLabel} />
    : stateLabel}
</Badge>
```

- [ ] **Step 2: Wrap jargon in `feature-detail.tsx`**

Open `dashboard/components/feature-detail.tsx`. Add the import. Wrap any literal strings: `"Gate B"` → `<Term k="gate-b" />`, `"EvidenceBundle"` → `<Term k="evidence-bundle" />`, any `"Pillar N"` references → matching key.

- [ ] **Step 3: Wrap jargon in `run-progress.tsx` and `run-progress-drawer.tsx`**

Open each. Add the import. Wrap any phrase like `"in motion"` (when used as a status label, not a verb in a sentence) with `<Term k="in-motion" />`. If neither file contains glossary terms in user-visible strings, skip — leave a `// no glossary terms in user-visible strings` comment so reviewers know it was considered.

- [ ] **Step 4: Wrap jargon in `pipeline-board.tsx`**

Open `dashboard/components/pipeline-board.tsx`. Add the import. If gate columns are titled `"Gate B"` (or similar matching a glossary key), wrap the column heading with `<Term k="gate-b" />`.

- [ ] **Step 5: Wrap jargon in `inbox-item.tsx`**

Open `dashboard/components/inbox-item.tsx`. Add the import. Wrap any visible gate labels matching glossary keys.

- [ ] **Step 6: Run all tests**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm test
```

Expected: all pass. If a card/detail/inbox test asserts on text via `getByText`, it should still work since `<Term>` renders the text inside. If a test asserts on bare span vs button, relax to `getByText`.

- [ ] **Step 7: Commit**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent"
git add dashboard/components/feature-card.tsx \
        dashboard/components/feature-detail.tsx \
        dashboard/components/run-progress.tsx \
        dashboard/components/run-progress-drawer.tsx \
        dashboard/components/pipeline-board.tsx \
        dashboard/components/inbox-item.tsx
git commit -m "feat(dashboard): <Term> in feature + run + pipeline + inbox"
```

---

## Task 12: Sweep `<Term>` into repo + install components

**Files:**
- Modify: `dashboard/components/repo-card.tsx`
- Modify: `dashboard/components/install-workflow-panel.tsx`
- Modify: `dashboard/components/setup-checklist.tsx`

- [ ] **Step 1: Wrap jargon in `repo-card.tsx`**

Open `dashboard/components/repo-card.tsx`. Add the import. Wrap any `"wire-up"` / `"wired"` label that refers to the dev-agent action (not a generic adjective) with `<Term k="wire-up" />`. Wrap any pillar reference.

- [ ] **Step 2: Wrap jargon in `install-workflow-panel.tsx`**

Open `dashboard/components/install-workflow-panel.tsx`. Add the import. Wrap:
- `"wire-up"` → `<Term k="wire-up" />`
- `"Tier-2 smoke"` or `"tier-2 smoke"` → `<Term k="tier2-smoke" />`
- `"swarm override"` → `<Term k="swarm-override" />`

- [ ] **Step 3: Wrap jargon in `setup-checklist.tsx`**

Open `dashboard/components/setup-checklist.tsx`. Add the import. Wrap `"wire-up"` and any pillar references.

- [ ] **Step 4: Run all tests**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent"
git add dashboard/components/repo-card.tsx \
        dashboard/components/install-workflow-panel.tsx \
        dashboard/components/setup-checklist.tsx
git commit -m "feat(dashboard): <Term> in repo card + install + setup"
```

---

## Task 13: Embed full glossary in `<HelpPanel>`

**Files:**
- Modify: `dashboard/components/help-panel.tsx`
- Modify: `dashboard/__tests__/components/help-panel.test.tsx`

- [ ] **Step 1: Extend the existing help-panel test**

Open `dashboard/__tests__/components/help-panel.test.tsx` and replace contents with:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HelpPanel } from '@/components/help-panel';

describe('<HelpPanel>', () => {
  it('opens when the trigger is clicked and shows the pitch', () => {
    render(<HelpPanel />);
    fireEvent.click(screen.getByRole('button', { name: /help/i }));
    expect(screen.getAllByText(/dev-agent/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/30 second/i)).toBeInTheDocument();
  });

  it('renders the Glossary section listing every term', () => {
    render(<HelpPanel />);
    fireEvent.click(screen.getByRole('button', { name: /help/i }));
    expect(screen.getByRole('heading', { name: /glossary/i })).toBeInTheDocument();
    // Spot-check a few known labels are present in the drawer
    expect(screen.getByText('Gate B')).toBeInTheDocument();
    expect(screen.getByText('EvidenceBundle')).toBeInTheDocument();
    expect(screen.getByText('Tier-2 smoke')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm test -- __tests__/components/help-panel.test.tsx
```

Expected: FAIL on the new Glossary assertion.

- [ ] **Step 3: Replace `help-panel.tsx` body to embed the glossary**

Open `dashboard/components/help-panel.tsx` and replace with:

```tsx
'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import Link from 'next/link';
import { GLOSSARY } from '@/lib/glossary';

export function HelpPanel() {
  const [open, setOpen] = useState(false);
  const entries = Object.values(GLOSSARY);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          aria-label="Help"
          className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border text-sm hover:bg-accent hover:text-accent-foreground"
        >
          ?
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content className="fixed inset-y-0 right-0 w-full max-w-md overflow-y-auto bg-background p-6 shadow-lg">
          <Dialog.Title className="text-lg font-semibold">About dev-agent</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-muted-foreground">
            A 30 second pitch: dev-agent watches your wired-up repos, lets you brainstorm features
            with a PM agent, ships them through gated phases (spec → PR → promote), and runs
            verification pillars on every change so you can trust what merged.
          </Dialog.Description>
          <div className="mt-6">
            <h3 className="mb-2 text-sm font-medium">What to do today</h3>
            <ul className="ml-5 list-disc text-sm text-muted-foreground">
              <li>
                Check <Link className="underline" href="/" onClick={() => setOpen(false)}>Home</Link> for what needs you.
              </li>
              <li>
                Open <Link className="underline" href="/intent" onClick={() => setOpen(false)}>Brainstorm</Link> to start something new.
              </li>
            </ul>
          </div>
          <div className="mt-8">
            <h3 className="mb-3 text-sm font-medium">Glossary</h3>
            <dl className="space-y-3">
              {entries.map((e) => (
                <div key={e.label} className="rounded-md border border-border p-3">
                  <dt className="font-medium text-foreground">{e.label}</dt>
                  <dd className="mt-1 text-xs text-muted-foreground">{e.short}</dd>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-accent hover:underline">More</summary>
                    <p className="mt-2 text-xs text-muted-foreground">{e.long}</p>
                    {e.link && (
                      <a
                        href={e.link}
                        className="mt-2 inline-block text-xs font-medium text-accent hover:underline"
                        target={e.link.startsWith('http') ? '_blank' : undefined}
                        rel={e.link.startsWith('http') ? 'noopener noreferrer' : undefined}
                      >
                        Learn more →
                      </a>
                    )}
                  </details>
                </div>
              ))}
            </dl>
          </div>
          <div className="mt-6 flex justify-end">
            <Dialog.Close asChild>
              <button className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground">
                Close
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm test -- __tests__/components/help-panel.test.tsx
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent"
git add dashboard/components/help-panel.tsx dashboard/__tests__/components/help-panel.test.tsx
git commit -m "feat(dashboard): embed full glossary inside HelpPanel drawer"
```

---

## Task 14: Playwright smoke spec

**Files:**
- Create: `dashboard/__tests__/e2e/ux-brand-help.spec.ts`

- [ ] **Step 1: Create the spec**

Create `dashboard/__tests__/e2e/ux-brand-help.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test.describe('UX — brand + help + nav', () => {
  test('nav shows WORK and INSIGHTS section labels', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText(/^WORK$/)).toBeVisible();
    await expect(page.getByText(/^INSIGHTS$/)).toBeVisible();
  });

  test('Home link has aria-current=page when on /', async ({ page }) => {
    await page.goto('/');
    const home = page.getByRole('link', { name: /^Home$/ });
    await expect(home).toHaveAttribute('aria-current', 'page');
  });

  test('no breadcrumb on top-level routes', async ({ page }) => {
    await page.goto('/repos');
    await expect(page.getByRole('navigation', { name: /breadcrumb/i })).toHaveCount(0);
  });

  test('Home shows "Needs you now" with a (?) bubble', async ({ page }) => {
    await page.goto('/');
    // The (?) bubble is a button labeled "What is Needs you now?"
    await expect(
      page.getByRole('button', { name: /what is needs you now/i }),
    ).toBeVisible();
  });

  test('clicking the (?) bubble opens the popover with the long body', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /what is needs you now/i }).click();
    await expect(page.getByText(/waiting on you to act/i)).toBeVisible();
  });

  test('HelpPanel drawer shows Glossary section', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /^help$/i }).click();
    await expect(page.getByRole('heading', { name: /glossary/i })).toBeVisible();
    await expect(page.getByText('EvidenceBundle')).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the spec (requires the dev server to start automatically per `playwright.config.ts`)**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm run test:e2e -- ux-brand-help
```

Expected: PASS, 6 tests. (Playwright will boot `next dev` automatically.)

If a test fails because the loaded Home requires GitHub auth, scope to `chromium` only and either (a) skip the auth-gated tests with `test.skip(!process.env.E2E_AUTH_TOKEN, …)`, or (b) leave the spec as-is and document in the commit message that this spec requires a logged-in dev session — same constraint the existing `happy-path.spec.ts` operates under.

- [ ] **Step 3: Commit**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent"
git add dashboard/__tests__/e2e/ux-brand-help.spec.ts
git commit -m "test(dashboard): playwright smoke for nav + help + brand"
```

---

## Task 15: Final verification + PR

- [ ] **Step 1: Run the full vitest suite + typecheck**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm run typecheck && npm test
```

Expected: both exit 0.

- [ ] **Step 2: Manual visual sweep**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent/dashboard"
npm run dev
```

Walk every page (Home, Repos, /repos/[wired], Intent, Pipeline, Proposals, Activity, Cost, /features/[any]). On each, confirm:

- Italic descriptor under H1.
- Active nav link is teal-underlined.
- Breadcrumb visible on inner pages, absent on top-level pages.
- Cmd-F for "Pillar", "Gate", "EvidenceBundle", "Tier-2", "swarm" — every match should be inside a `<Term>` (dotted underline visible).
- Open HelpPanel → Glossary section lists all terms.
- Toggle OS dark mode → palette parity, no unreadable text.

Kill dev server.

- [ ] **Step 3: Push branch and open PR**

```bash
cd "/Users/alizaouane/Documents/Qualiency/Software Dev/dev-agent"
git push -u origin feat/dashboard-ux-brand-help
gh pr create --title "feat(dashboard): brand refresh + inline help + nav restructure" --body "$(cat <<'EOF'
## Summary
- Re-skinned palette to Qualiency (navy primary, teal accent) via CSS tokens; dark-mode parity preserved.
- New `<Term>` primitive backed by `lib/glossary.ts` — hover tooltip + click popover for every jargon term, across 12 components.
- New `<PageHeader>` mounts an italic descriptor + (?) help bubble on every top-level page.
- Top nav restructured: primary triad unchanged, secondary items grouped under WORK/INSIGHTS labels with teal active-page underline.
- Breadcrumbs on inner pages (`/repos/:name`, `/features/:issue`, `/intent?repo=`).
- HelpPanel drawer now embeds the full glossary as a canonical reference.

## Test plan
- [ ] `npm test` passes
- [ ] `npm run test:e2e -- ux-brand-help` passes
- [ ] Visual sweep across all pages in both light and dark mode
- [ ] Active nav underline tracks correctly across page navigation
- [ ] Breadcrumb appears on `/repos/<wired>` and `/features/<n>`, absent on top-level pages
- [ ] HelpPanel glossary lists every term with expandable "More"

Spec: `docs/superpowers/specs/2026-05-23-dashboard-ux-brand-and-help-design.md`
Plan: `docs/superpowers/plans/2026-05-23-dashboard-ux-brand-and-help.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR opens; URL printed to stdout.

---

## Self-review notes (for the executor)

If you find a glossary term used inline in a component that isn't on the sweep list (Tasks 10-12), wrap it anyway and add the term key to `lib/glossary.ts` in the same commit. The sweep list is the floor, not the ceiling.

If `npm test` flags any existing test that asserts on a bare text element where you've inserted `<Term>`, the fix is almost always to switch the assertion from a specific DOM-type matcher to `getByText` (which is element-agnostic). Do not change the `<Term>` rendering to be a `<span>` instead of a `<button>` — the popover requires a focusable trigger.

If a page file's existing heading structure doesn't match the patterns assumed in Task 8 (e.g., uses `<div className="text-2xl">` instead of `<h1>`), still replace it with `<PageHeader>` — the goal is consistency.
