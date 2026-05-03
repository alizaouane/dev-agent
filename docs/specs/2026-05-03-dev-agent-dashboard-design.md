# dev-agent Dashboard — UI/UX Design (v1)

**Date:** 2026-05-03
**Owner:** ali.zaouane@hotmail.com
**Status:** Approved (brainstormed 2026-05-03 against the v0.1.0 engine).
**Working domain:** `dev-agent.qualiency.com`
**Engine version this dashboard ships against:** `v0.1.0` (consumer pin: `@v1`)

> The dev-agent engine (plugin + reusable workflows + `.dev-agent.yml` schema) shipped at `v0.1.0` provides the orchestration surface but no graphical interface — the "UI" in v0.1.0 is GitHub issues + labels + Claude Code slash commands. This spec adds a web dashboard that becomes the primary cockpit, with slash commands remaining as a power-user surface.

---

## Context

**Problem.** dev-agent v0.1.0 ships a working orchestration engine but no graphical interface. To use the system today, you either:
1. Open Claude Code, type `/develop "intent"` — works for power-users, requires Claude Code installed and a session open
2. Go to GitHub directly — read issues, manually flip labels for `/approve`, click into Actions to dispatch workflows — works but loses the "drop intent and let it ship" flow

Neither surface fits the "approve gates while away from your laptop" usage pattern that agentic feature dev unlocks. Mobile + at-a-glance + same UX across all your repos requires a real UI.

**The user is single (Ali Zaouane), Qualiency-owned repos.** The dashboard primarily serves one person across N Qualiency-owned consumer repos that have onboarded dev-agent (have a `.dev-agent.yml` at root). The architecture preserves optionality for bringing teammates onto the same dashboard later (real auth, allowlist) without rebuilds.

**Intended outcome.** A web dashboard at `dev-agent.qualiency.com` where the user lands and immediately sees only the things needing their action right now (gate approvals, blocked features), can drop new intent without leaving the page, can drill into any feature for telemetry/spec/PR-link, can scan the full pipeline across all repos, and can review aggregated cost. Mobile-friendly so phone-tap-to-approve works.

---

## Goals

- **Inbox-driven primary UX** — landing page shows only items needing user action, sorted by what's blocking the most pipeline value.
- **Cross-repo from day 1** — the dashboard reads pipeline state from every Qualiency-owned repo with `.dev-agent.yml` installed; no per-repo configuration in the dashboard.
- **No new state of its own** — GitHub issues are the source of truth; the dashboard is a presentation layer over the GitHub API. Easier to reason about, no sync bugs, no migrations.
- **Mobile-friendly via responsive design** — phone-tap to approve works without polishing for mobile-first; PWA / push notifications deferred (existing notification fan-out via `lib/notify.ts` covers push).
- **Single-user, team-ready architecture** — auth via real GitHub OAuth + allowlist (CSV env var). Adding a teammate later = add their handle to the env var, redeploy. No DB, no role system in v1.
- **Lives in the same repo as the engine** — `dev-agent/dashboard/` as an npm workspace member. Same tags, same release cadence.
- **Deploy to Vercel** — free tier handles single-user load comfortably; auto-deploy on push to `main` that touches `dashboard/**` or `lib/**`.

## Non-Goals

- Replacing the slash commands. They remain available for power-users who prefer Claude Code session ergonomics.
- Real-time updates (SSE/WebSockets). Deferred to v1.5 or later — page-load freshness is sufficient for single-user.
- Scout proposal triage UI. Scout itself is stubbed in v0.1.0; UI for it lands when scout is real (Phase 3+).
- Cross-organization aggregation beyond `qualiency`. The dashboard reads only repos in allowlisted orgs.
- Public open-source release. Dashboard is single-user (Qualiency-only) for now; if the engine is open-sourced later, the dashboard separates into its own repo at that time.
- Native iOS/Android apps. Browser PWA path is future work.

## Constraints

- The dashboard must work against **any consumer repo** with a `.dev-agent.yml` at default-branch root. No Caliente-specific behavior. Repo-discovery is automatic via the GitHub API.
- All actions performed by the dashboard happen **as the authenticated user**, using their GitHub OAuth token. The dashboard has no special privileges of its own.
- Honor the existing engine contract: state lives in GitHub issue labels per `lib/orchestrator.ts`; telemetry comments per `lib/telemetry.ts` format; mutations via the same label-flip + workflow-dispatch flow that the slash commands document.
- No untrusted-input handling concerns at the workflow boundary — the dashboard does not push code, it only flips labels and dispatches workflows. The engine workflows handle their own untrusted-input safety (already validated in v0.1.0).
- The dashboard repo lives at `dashboard/` inside `alizaouane/dev-agent` (monorepo). The plugin manifest at `.claude-plugin/plugin.json` does not reference `dashboard/`, so plugin consumers do not pull dashboard code into their `~/.claude/plugins/`.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (Chrome on laptop / Safari on phone)               │
│  ↓                                                           │
│  https://dev-agent.qualiency.com                            │
│  ↓                                                           │
│  Vercel-hosted Next.js 15 app (App Router, RSC, server actions) │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ NextAuth (GitHub OAuth) → allowlist check            │  │
│  │ ↓                                                     │  │
│  │ React Server Components ── server-side ──→ GitHub API│  │
│  │ Server Actions ────────────────────────→ GitHub API   │  │
│  └──────────────────────────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────────────┘
                           │ reads issues / labels / comments
                           │ writes labels (approve), creates issues (intent)
                           │ dispatches workflows (kick off phase-implement etc.)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  GitHub (Qualiency-owned repos with .dev-agent.yml installed)│
│  Issues + labels + comments = state                          │
│  Workflows fire on label changes + workflow_dispatch         │
└──────────────────────────────────────────────────────────────┘
```

### Why this shape

1. **Stateless** — the dashboard holds no state of its own. State lives in GitHub. Removing the dashboard removes the cockpit, not the engine.
2. **Server Components + Server Actions** — Next 15 native pattern. Form submits → server action → GitHub API call → revalidate → UI updates. No separate API routes, no client-side data-fetching libraries.
3. **No database in v1** — GitHub is the source of truth; cost/activity rollups can be computed on-demand for single-user volumes (~5 repos × ~10 features × ~7 telemetry comments = ~350 comments to aggregate, easily fetched in 5–10s on cold load). Add a cache layer later only if measured friction warrants.
4. **Same repo as the engine** — single tag set, atomic engine + dashboard changes, shared types via npm workspace. Plugin consumers don't see the dashboard code (manifest doesn't reference it).
5. **Vercel hosting** — best free tier for Next.js, owned domain (`qualiency.com`) DNS already in Vercel, deploy via existing patterns.

---

## File structure (dashboard/ added to existing repo)

```
dev-agent/                                          # existing repo
├── lib/, commands/, skills/, prompts/, schema/    # engine (unchanged)
├── examples/test-repo/                             # synthetic consumer (unchanged)
├── .claude-plugin/plugin.json                      # plugin manifest (does NOT reference dashboard/)
├── .github/workflows/                              # existing reusable workflows + new: deploy-dashboard.yml
├── docs/                                           # specs, plans, runbooks (unchanged)
├── dashboard/                                      # ← NEW workspace member
│   ├── package.json                                # Next.js app deps; depends on workspace root for shared types
│   ├── next.config.ts
│   ├── tsconfig.json
│   ├── tailwind.config.ts
│   ├── postcss.config.mjs
│   ├── components.json                             # shadcn/ui config
│   ├── public/                                     # static assets (favicon, og image)
│   ├── app/
│   │   ├── layout.tsx                              # root layout: nav header, auth guard, font setup
│   │   ├── page.tsx                                # / → inbox (default route)
│   │   ├── pipeline/page.tsx                       # /pipeline → kanban/table of all in-flight
│   │   ├── cost/page.tsx                           # /cost → spend dashboard
│   │   ├── activity/page.tsx                       # /activity → chronological feed
│   │   ├── repos/[name]/page.tsx                   # /repos/<name> → per-repo drill-down
│   │   ├── features/[issue]/page.tsx               # /features/<n> → single feature deep-dive
│   │   ├── intent/page.tsx                         # /intent → drop-intent form (full-page; modal opens at any route)
│   │   ├── auth/signin/page.tsx                    # sign-in landing
│   │   ├── auth/error/page.tsx                     # 403 / not-allowlisted page
│   │   └── api/auth/[...nextauth]/route.ts         # NextAuth handler
│   ├── components/
│   │   ├── ui/                                     # shadcn/ui primitives (button, card, dialog, table, …)
│   │   ├── nav-header.tsx                          # persistent top nav (drop-intent button + repo picker + avatar)
│   │   ├── inbox-list.tsx                          # the inbox primary list
│   │   ├── inbox-item.tsx                          # one row in the inbox
│   │   ├── pipeline-board.tsx                      # kanban for /pipeline
│   │   ├── feature-detail.tsx                      # the deep-dive panel
│   │   ├── intent-modal.tsx                        # drop-intent dialog
│   │   ├── cost-chart.tsx                          # recharts wrapper
│   │   └── activity-feed.tsx                       # chronological list
│   └── lib/
│       ├── auth.ts                                 # NextAuth config + allowlist check
│       ├── gh.ts                                   # Octokit client + per-request session token
│       ├── repos.ts                                # discover repos with .dev-agent.yml
│       ├── pipeline.ts                             # query in-flight features across repos
│       ├── telemetry.ts                            # parse the per-phase telemetry comment format
│       └── actions.ts                              # server actions (approve, abandon, dispatch, …)
└── package.json                                    # ROOT — declares workspaces: ["dashboard"]
```

---

## Routes & screens

The dashboard ships **7 routes**. The default route is the inbox (Q3 brainstorm decision: inbox primary, pipeline secondary).

| Route | Purpose | Primary actions |
|---|---|---|
| `/` (inbox) | Items that need *your* action right now | Approve / Abandon / Open in GitHub |
| `/pipeline` | Full kanban or table of every in-flight feature across all repos, columns by state | Filter by repo / state, click into feature |
| `/cost` | Anthropic spend rolled up by repo and phase, last 30 days, with daily-burn chart | Filter by repo / model |
| `/activity` | Chronological event feed (PR opened, smoke passed, drift-check failed, …) | Click into feature for context |
| `/repos/[name]` | Per-repo drill: that repo's in-flight features, status file content, recent activity | Same as inbox/pipeline scoped to one repo |
| `/features/[issue]` | Single feature deep-dive: spec content, telemetry per phase, drift report, PR link, full timeline | All gate-action buttons, link to PR, link to GH issue |
| `/intent` | Drop-intent form (full-page) | Submit creates GH issue + dispatches initial workflow |

**Persistent nav** on every route (top header):
- "Drop intent" button (opens `IntentModal` — same form as `/intent`)
- Repo picker (filters the current view to a single repo)
- Notifications icon (count of inbox items)
- User avatar with sign-out menu

**Default landing for an authenticated user** = `/` (inbox). If the inbox is empty, it shows a positive empty-state ("All clear — drop new intent or check the pipeline") with shortcuts.

---

## Components (the units with clear boundaries)

| Module | Responsibility | Inputs | Outputs |
|---|---|---|---|
| `lib/auth.ts` | NextAuth config (GitHub OAuth) + allowlist check (`ALLOWED_GH_USERNAMES`, `ALLOWED_GH_ORGS`) | Env vars + GitHub OAuth callback | Authenticated session or 403 |
| `lib/gh.ts` | Octokit instance with the session's access token | NextAuth session | Authenticated Octokit client |
| `lib/repos.ts` | List repos in allowlisted orgs that have `.dev-agent.yml` at default-branch root | Octokit + allowlist | `Repo[]` (name, default branch, parsed `.dev-agent.yml` snapshot) |
| `lib/pipeline.ts` | For a set of repos, fetch all issues with `state:*` labels and parse latest telemetry. Filterable (`needs-action`, `by-state`, `non-terminal`, …) | Octokit + `Repo[]` + filter | `FeatureItem[]` (issue + state + age + cost + last update) |
| `lib/telemetry.ts` | Parse the `🤖 Phase: <name>` comment format → structured cost/tokens | Comment body string | `Telemetry \| null` |
| `lib/actions.ts` | All mutations as server actions: `dropIntent`, `approveGate`, `abandonFeature`, `dispatchRollback`, `dispatchPhase` | Form data + session | Updated state + redirect |

Each module has a single purpose, can be unit-tested independently, and has a typed boundary. `pipeline.ts` is the central read-side abstraction every screen ultimately depends on.

---

## Auth & access control

### OAuth flow

1. Anonymous user visits any `/*` route
2. NextAuth middleware detects no session → redirects to `/auth/signin`
3. Sign-in page has a "Sign in with GitHub" button
4. GitHub OAuth flow: scopes requested are `repo` (read+write issues), `workflow` (dispatch workflow_dispatch on phase-* workflows), and `read:org` (verify org membership for the allowlist)
5. Callback runs `lib/auth.ts` allowlist check:
   - If `session.user.username` ∈ `ALLOWED_GH_USERNAMES` (CSV) → mint session
   - Else if `session.user.username` is a member of any org ∈ `ALLOWED_GH_ORGS` (CSV, verified via `octokit.orgs.checkMembershipForUser`) → mint session
   - Else → redirect to `/auth/error` (403 page with "request access" instructions; manual)
6. Session cookie set (HttpOnly, Secure, SameSite=Lax). Access token stored server-side, encrypted via `NEXTAUTH_SECRET`. Token never reaches the browser.

### Why this shape

- **No user database** — allowlist is two env vars; team-readiness without per-user state.
- **No special dashboard privileges** — every GitHub action happens as the authenticated user via their token. If the user lacks `write` on a repo, the action fails server-side with the user's permission error, surfaced as a clear UI message.
- **Token scope is broad-by-necessity** — `repo` + `workflow` covers reading issues + flipping labels + dispatching workflows. We can narrow if Granular OAuth Apps gain feature parity for label-write + workflow-dispatch (currently they don't reliably).
- **Session length** — 30 days, refreshed on activity. After 30 days idle, user re-signs-in.

### Permission verification per action

Each server action begins with:
```ts
const session = await getSession();
if (!session) throw new UnauthorizedError();
const octokit = ghClient(session);
// Verify write access on the target repo (one cheap API call):
const perm = await octokit.repos.getCollaboratorPermissionLevel({owner, repo, username: session.user.username});
if (!['admin', 'write', 'maintain'].includes(perm.data.permission)) throw new ForbiddenError();
// Proceed with mutation
```

This means that even if someone in `ALLOWED_GH_USERNAMES` doesn't have `write` on a specific repo, they can read but not approve / abandon / dispatch on that repo. UI surfaces this by graying out action buttons and showing a tooltip.

---

## Data flow

### Read flow (every page render)

Every route is a React Server Component. Server-side render does:

```ts
// Example: app/page.tsx (inbox)
export default async function InboxPage() {
  const session = await getSession();
  const octokit = ghClient(session);
  const repos = await listAllowedRepos(octokit);                  // discover .dev-agent.yml repos
  const items = await pipeline.needsAction(octokit, repos);       // filter to gate-approval / blocked items
  return <InboxList items={items} />;
}
```

`listAllowedRepos` filters via the GitHub API to repos in `ALLOWED_GH_ORGS` that have a `.dev-agent.yml` at the default branch root. One `octokit.repos.getContent({path: '.dev-agent.yml'})` HEAD check per repo, parallelized via `Promise.all`. Result memoized in-request (no cross-request cache in v1).

### Per-route GitHub API call budget

Calculated for a representative load: 5 repos × 5 in-flight features each.

| Route | API calls (cold) | Latency budget |
|---|---|---|
| `/` (inbox) | ~10 (list issues filtered to non-terminal states across repos + each issue's last comment) | ~1.5 s |
| `/pipeline` | ~10 (same set, no filter) | ~1.5 s |
| `/features/[n]` | 3 (issue, comments, linked PR) | ~600 ms |
| `/cost` | issues + ALL telemetry comments across last 30 days (~50 comments) | ~5–10 s cold (acceptable for single-user; cache later if needed) |
| `/intent` (form render) | 1 (list of available repos for the picker) | ~300 ms |
| `/intent` submit (server action) | 2 (create issue, dispatch workflow) | ~1 s |
| `/repos/[name]` | ~5 (issues + comments scoped to one repo) | ~1 s |
| `/activity` | ~10 (recent events from issue updates across repos) | ~2 s |

**GitHub rate limit:** 5 000 / hour authenticated. Single-user with 5 repos doing ~30 page loads / hour ≈ 300 calls / hour, ~6 % of budget. Plenty of headroom.

### Mutations — server actions

All mutations are Next.js server actions, marked `'use server'`, defined in `lib/actions.ts`:

```ts
export async function dropIntent(formData: FormData) {
  const session = await getSession();
  const octokit = ghClient(session);
  const repo = formData.get('repo') as string;
  const intent = formData.get('intent') as string;
  // Verify write permission on the target repo
  await assertWritePermission(octokit, session.user.username, repo);
  // Create the issue with kind:user-intent, state:scoping. Body includes
  // copy-paste instructions for the user to run /develop in Claude Code
  // for the interactive spec-brainstorm step.
  const body = `${intent}\n\n---\n\n**Next step:** the spec brainstorm is an interactive session in Claude Code. From the \`${repo}\` repo:\n\n\`\`\`\n/develop https://github.com/${owner}/${repo}/issues/<this-issue-number>\n\`\`\``;
  const issue = await octokit.issues.create({owner, repo, title: intent.slice(0, 100), body, labels: ['kind:user-intent', 'state:scoping']});
  redirect(`/features/${issue.data.number}?repo=${repo}`);
}

export async function approveGate(repo: string, issue: number, promote: boolean) { ... }
export async function abandonFeature(repo: string, issue: number, reason?: string) { ... }
export async function dispatchRollback(repo: string, issue: number) { ... }
```

Each action verifies write permission (one cheap API call), performs the mutation atomically where possible (label change + comment in the same `gh issues.update` call), and calls `revalidatePath` on affected routes so the UI updates without a hard reload.

**Why `dropIntent` doesn't fully kick off the pipeline:** the spec-brainstorm step is interactive (the agent dialogs with the human to refine intent). It can't run as a fire-and-forget GitHub workflow. v1 dashboard creates the issue + state:scoping, then surfaces the `/develop <url>` command for the user to copy-paste into a Claude Code session in the target repo. After the spec is written and the issue moves to `state:spec-ready`, all subsequent gates (`/approve`, `/approve --promote`, `/abandon`, `/rollback`) work entirely from the dashboard via label flips + workflow_dispatch — no Claude Code needed. Future v1.5 may add an inline chat-style brainstorm UI inside the dashboard so even step-zero stays in the browser; deferred for now.

---

## Error handling

Three layers, scaled to severity:

| Layer | Failure mode | Handling |
|---|---|---|
| **Auth** | No session | Redirect to `/auth/signin` |
| | Allowlist rejection | Redirect to `/auth/error` with "request access" instructions (manual — they email you) |
| | OAuth token revoked / expired | Same as no-session — redirect to sign-in |
| **GitHub API** | 429 rate-limited | Inline empty-state showing reset-at time; refresh button |
| | Network error / timeout | Inline empty-state ("couldn't reach GitHub — try again"); log to Vercel logs |
| | 404 (repo deleted, issue gone) | Show "this resource was deleted" page; offer link back to inbox |
| | 403 (user lacks permission) | Action buttons grayed out with tooltip; mutations return clear error |
| **Data** | `.dev-agent.yml` doesn't parse | Skip that repo from the dashboard, log the parse error, surface inline warning ("`X` repos had unparseable configs") |
| | Telemetry comment malformed | Skip that comment, render the rest, surface count of skipped comments |
| | Issue has unknown `state:*` label | Show as "unknown state" with the raw label; don't crash |

**No telemetry/observability service in v1.** Vercel logs cover error tracking for single-user. Add Sentry / PostHog only if the friction warrants.

---

## Testing strategy

| Layer | What | Tool | Why |
|---|---|---|---|
| **Unit** | `lib/telemetry.ts` parser, `lib/repos.ts` filter, `lib/auth.ts` allowlist check | Vitest (already configured at repo root) | Pure functions, fast, deterministic |
| **Component** | `<InboxItem>`, `<PipelineBoard>`, `<IntentForm>` snapshot + interaction tests with mocked data | Vitest + React Testing Library | Catches layout regressions and ARIA issues |
| **Integration** (server actions) | `dropIntent`, `approveGate`, `abandonFeature` against mocked Octokit recording calls | Vitest + Octokit-mocking | Verifies the right GitHub API calls happen in the right order; doesn't hit real API |
| **E2E** | Happy-path: sign in → drop intent → see in inbox → approve → state advances | Playwright against local dev server with mocked GH backend (MSW) | Verifies full UX flow end-to-end |
| **Manual smoke** | After every deploy: hit `/`, drop a real intent against `examples/test-repo`, click through | Just you | Catches "Vercel env var missing" type stuff |

**No live-API integration tests in CI** — would require a test GitHub org and real OAuth. The mocked-Octokit integration tests are the safety net.

---

## Deployment

### Vercel project

- **Project name:** `dev-agent-dashboard`
- **Linked repo:** `alizaouane/dev-agent`
- **Production branch:** `main`
- **Root directory:** `dashboard/`
- **Build command:** auto-detected (Next.js)
- **Auto-deploy:** on every push to `main` that touches `dashboard/**` OR `lib/**` (engine type changes)
- **Preview deploy:** on every PR that touches `dashboard/**`

### Domain

- **Production:** `dev-agent.qualiency.com` (CNAME to Vercel; DNS already in Vercel)
- **Preview deploys:** Vercel-generated `*.vercel.app` URLs (one per PR)

### Required Vercel env vars

| Name | Value | Notes |
|---|---|---|
| `NEXTAUTH_URL` | `https://dev-agent.qualiency.com` (prod) / `$VERCEL_URL` (preview) | NextAuth callback target |
| `NEXTAUTH_SECRET` | `openssl rand -base64 32` (generated once, marked sensitive) | Encrypts session cookies |
| `GITHUB_OAUTH_CLIENT_ID` | From GitHub OAuth App | Created twice — once for prod, once for preview, with their respective callback URLs |
| `GITHUB_OAUTH_CLIENT_SECRET` | Same OAuth App | Marked sensitive |
| `ALLOWED_GH_USERNAMES` | `alizaouane` | Comma-separated |
| `ALLOWED_GH_ORGS` | `qualiency` (or empty) | Comma-separated, optional |

### New CI workflow at `.github/workflows/deploy-dashboard.yml`

```yaml
name: Deploy dashboard
on:
  push:
    branches: [main]
    paths: ['dashboard/**', 'lib/**']
  pull_request:
    paths: ['dashboard/**']

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm run typecheck --workspace=dashboard
      - run: npm test --workspace=dashboard

  deploy:
    needs: test
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-args: '--prod'
          working-directory: dashboard
```

The existing engine CI (`ci.yml`) keeps running on every push (no path filter) since engine changes can affect workflow contracts. Dashboard CI is path-filtered so unrelated engine changes don't trigger a Vercel deploy.

### GitHub repo secrets needed for the deploy CI

| Name | Value | Where to get it |
|---|---|---|
| `VERCEL_TOKEN` | Vercel personal access token | Vercel → Settings → Tokens |
| `VERCEL_PROJECT_ID` | Vercel project ID | Vercel project Settings |
| `VERCEL_ORG_ID` | Vercel org ID | Vercel team Settings |

---

## Mobile-friendly responsive design

Tailwind breakpoints and shadcn/ui components handle most of this naturally. Specific guarantees:

| Screen | < 640 px (phone) | 640–1024 px (tablet) | ≥ 1024 px (laptop) |
|---|---|---|---|
| Inbox `/` | Single-column list, large tap targets, swipe-disabled | Single-column with secondary metadata | Single-column, sidebar with quick filters |
| Pipeline `/pipeline` | Stacked card list (no kanban — kanban doesn't fit phone) | 3-column kanban with horizontal scroll | 5-column kanban (one per non-terminal state) |
| Cost `/cost` | Daily total + top-3 features by spend, no charts | Charts + table | Full charts + drill-down table |
| Activity `/activity` | Chronological list (no change vs desktop) | Same | Same |
| Feature deep-dive `/features/[n]` | Vertical sections (spec, telemetry, drift, links) | Same vertical | 2-column: left = spec, right = telemetry |
| Intent `/intent` | Full-page form, single column | Same | Same (form is small) |
| Nav header | Hamburger menu (drop-intent, repo picker, avatar collapse) | Same as desktop | Inline buttons |

No PWA / service worker / push notifications in v1. Push notifications are already covered by the engine's `lib/notify.ts` fan-out (ntfy.sh, Pushover, Resend email) configured in each consumer's `.dev-agent.yml`.

---

## Cost analytics (the `/cost` route — design detail)

The cost dashboard is the only route that aggregates historical data. v1 implementation:

1. On render, query GitHub for all issues across allowed repos with `state:*` labels (terminal or in-flight).
2. For each issue, fetch its comments (paginated).
3. Run `lib/telemetry.ts` against each comment; keep the parseable ones.
4. Aggregate client-side (in the server component): group by date, repo, phase, model. Sum dollars.
5. Render charts via `recharts` (lightweight, MIT, works server-side for SSR + hydrates client-side for interactivity).

**Charts shown:**
- Daily Anthropic spend, last 30 days, stacked-bar by phase
- Top 5 spendiest features in the period
- Per-repo total spend, sorted descending
- Per-model split (haiku / sonnet / opus)

**Cold load is 5–10 s** for the data described. v1 ships with a "loading…" skeleton; v1.5 can add a small KV cache or a daily cron that pre-aggregates. **Not a blocker.**

---

## Implementation phasing

### Phase 2.5 (this spec): build the dashboard

**Goal:** Ship `dev-agent.qualiency.com` running v1 of the dashboard against the v0.1.0 engine.

**Build:**
- Create `dashboard/` workspace member
- NextAuth + GitHub OAuth + allowlist
- 7 routes scaffolded with shadcn/ui
- `lib/auth.ts`, `lib/gh.ts`, `lib/repos.ts`, `lib/pipeline.ts`, `lib/telemetry.ts`, `lib/actions.ts`
- All server actions wired
- Cost dashboard with recharts
- Deploy-dashboard CI workflow
- Vercel project + DNS
- Manual smoke against `examples/test-repo`

**Validation:**
- Sign in flow works end-to-end against your real GitHub account
- Inbox correctly surfaces a manually-created `state:spec-ready` issue across any repo with `.dev-agent.yml`
- "Drop intent" creates a real GitHub issue + dispatches `phase-implement.yml` against `examples/test-repo`
- Approve flips the label and triggers the next phase workflow
- Mobile viewport (Chrome DevTools 375 px) renders all routes without horizontal scroll
- Vercel preview deploy works on a PR
- Production deploy works on merge to main

**Estimated effort:** ~2 weeks of focused build (per the brainstorm Approach B estimate).

### Phase 3 (later): real-time + scout UI + PWA upgrades

Deferred until v1 has been used for a few weeks and friction is measured.

---

## Critical files (this spec)

**New:**
- `dashboard/package.json` (workspace member)
- `dashboard/next.config.ts`
- `dashboard/app/{layout,page,...}.tsx` (7 routes + auth pages)
- `dashboard/components/{ui,nav-header,inbox-list,pipeline-board,intent-modal,...}.tsx`
- `dashboard/lib/{auth,gh,repos,pipeline,telemetry,actions}.ts`
- `dashboard/__tests__/{...}.test.ts(x)` for all of the above
- `.github/workflows/deploy-dashboard.yml`
- `docs/specs/2026-05-03-dev-agent-dashboard-design.md` (this file)

**Modified:**
- `package.json` (root) — declares workspaces: `["dashboard"]`
- `README.md` — adds dashboard subsection with the production URL + sign-in instructions

**Untouched:**
- All existing engine code (`lib/`, `commands/`, `skills/`, `prompts/`, `schema/`, `examples/`, `.claude-plugin/`)
- Existing reusable workflows
- Existing `ci.yml`

---

## Acceptance criteria

**Build:**
- [ ] `npm run typecheck --workspace=dashboard` passes
- [ ] `npm test --workspace=dashboard` passes (all unit + component + integration tests green)
- [ ] Playwright E2E: happy-path test passes against local dev server with MSW
- [ ] No regressions in engine tests (existing 196/196 stays green)

**Deploy:**
- [ ] `dev-agent.qualiency.com` resolves to a Vercel-hosted Next.js app
- [ ] GitHub OAuth sign-in completes end-to-end
- [ ] Allowlist correctly rejects non-allowlisted GitHub accounts
- [ ] Vercel preview deploys fire on PRs touching `dashboard/**`
- [ ] Production deploys fire on `main` push touching `dashboard/**` or `lib/**`

**UX (manual smoke):**
- [ ] Inbox surfaces real-state issues across at least 2 repos with `.dev-agent.yml`
- [ ] Drop-intent creates a real GitHub issue and dispatches the right workflow
- [ ] Approve button flips label and dispatches the next phase workflow
- [ ] Cost dashboard renders charts within 10 s on cold load
- [ ] All routes render without horizontal scroll at 375 px viewport
- [ ] All routes render correctly at ≥ 1024 px viewport

---

## Open questions / risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | Vercel free tier limits (function execution time, bandwidth) for cost-dashboard cold loads at 5–10 s | Free tier function execution is 10 s on Hobby — this is right at the edge. If we hit it, upgrade to Pro ($20/mo) or add a tiny KV cache pre-aggregating cost data. |
| 2 | GitHub OAuth scope `repo` is broad (read/write all repos, not just allowlisted). | Acceptable for single-user; documented. If we open this to teammates later, evaluate Granular OAuth Apps when they reach feature parity for label-write + workflow-dispatch. |
| 3 | NEXTAUTH_SECRET rotation policy unclear | Generate fresh on initial deploy; rotate annually or on suspected compromise. Rotation invalidates all sessions (all users re-sign-in). Acceptable. |
| 4 | Adding a teammate later requires Vercel env var edit + redeploy | Acceptable. Could later move allowlist to a small JSON file in the repo with a CI step that validates and auto-redeploys. |
| 5 | Cost data is computed per-request — no rollup table — so historical cost views beyond 30 days are slow | v1 is bounded to 30-day window. Beyond that, v1.5 introduces a daily-rollup cron. |
| 6 | Spec brainstorm step is interactive and can't run as a fire-and-forget workflow | v1 dashboard creates issue + surfaces `/develop <url>` for user to run in Claude Code. v1.5 may add inline chat-brainstorm UI. Documented in mutations section. |
| 7 | Form-CSRF protection for server actions | Next 15 server actions have built-in CSRF protection via the same-origin requirement. No extra work needed. |
| 8 | Shared types between `dashboard/` and engine `lib/` — npm workspaces vs published package | Workspaces with a relative import path (`'../lib/types'`) is sufficient. If the dashboard is ever extracted to its own repo, it becomes a published `@dev-agent/types` package. |

---

## Verification

**Phase 2.5 acceptance:**
- Manual: sign in, drop a real intent against `examples/test-repo`, watch it appear in the inbox, click approve, see the workflow fire on GitHub, see the state advance, see the telemetry comment appear in the deep-dive page within ~30 s of the workflow completing.
- Automated: full test suite green (unit, component, integration, Playwright E2E happy-path).
- Visual: screenshot every route at 375 px and 1440 px; commit the screenshots to `dashboard/__tests__/visual/` for regression baseline.

---

## Implementation steps (summary — full plan generated by `writing-plans` skill after spec approval)

**Step 0: Approve this spec.** User reviews the spec doc, requests changes if any.

**Step 1: Create implementation plan** via `writing-plans` skill.

**Step 2: Execute the plan task-by-task.** Each task ships an atomic commit with tests; PR opens once a logical chunk is done. Same workflow as Plans 1a–1d.

**Step 3: Manual smoke + first prod deploy.** Run the full UX validation; tag `v0.2.0` (engine + dashboard combined major-line bump signals "the dashboard is now live").

---

## Appendix: why monorepo (decided 2026-05-03)

User asked why the dashboard couldn't be in the same repo as the engine; the prior recommendation defaulted to a separate repo. The right answer is: **monorepo is fine for single-user with both halves moving in lockstep**, and it has practical benefits (atomic engine + dashboard changes, shared types via workspace import, one tag set, one CI). The alleged downsides (consumer fetches dashboard code via `uses: …@v1`, plugin install pulls dashboard code) are bandwidth-only at this size, not functional. If the engine is ever open-sourced or grows beyond what fits comfortably in one repo, splitting at that point is a one-day mechanical task.
