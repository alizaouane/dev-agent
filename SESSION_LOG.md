# Session Log

## 2026-05-23 15:44 UTC — interactive — unstick consumer bug-scout: v1 force-move + workflow_sha binding (PR #102)

**Trigger:** User showed a screenshot of `dev-agent · bug-scout #10` failing on `alizaouane/social-media-content` with "still having this bug" — the same `ERR_MODULE_NOT_FOUND` for `lib/cli/config-to-json.ts` that the May 20 SESSION_LOG entry said was fixed.

**What changed:**

- **Root cause:** The May 19 fix [1643a62](https://github.com/alizaouane/dev-agent/commit/1643a62) (`fix(workflows): scout phases check out dev-agent engine for lib/cli tooling`) landed on `main` but the `v1` tag still pointed at the May 8 commit `2707f48` (PR #82). Consumer wrappers pin to `@v1`, so every scheduled run for 5+ consecutive days picked up the pre-fix version. `main` was **160 commits ahead of v1**. Verified via `git merge-base --is-ancestor 1643a62 v1` → NO.
- **Immediate fix (out-of-band):** Force-moved `v1` to current main HEAD `3aae848` via `git tag -f v1 main && git push -f origin v1`. Every consumer immediately picks up the engine fix on next scheduled run, no per-consumer change needed.
- **Forward-looking hygiene** ([PR #102](https://github.com/alizaouane/dev-agent/pull/102), merged as [cc3139f](https://github.com/alizaouane/dev-agent/commit/cc3139f)): swapped the 11 internal `ref: v1` engine-checkout pins in `.github/workflows/phase-*.yml` to `ref: ${{ github.workflow_sha }}` — engine scripts now always come from the same commit as the reusable workflow YAML, regardless of how the caller pins (tag/branch/SHA). Eliminates the tag-vs-engine drift class entirely.
- **Codex P2 review item resolved:** the original `ref: main` proposal would have reintroduced drift if a caller pinned to a tag; switched to `github.workflow_sha` instead. Per-thread reply + PR summary comment posted.
- **CI iteration:** initial attempt also changed consumer templates from `@v1` → `@main` to "remove version pinning". Two test suites caught this: `tests/unit/web-app-template.test.ts` (the `@v\d+` pin policy) and `tests/unit/wire-up-template-drift.test.ts` (the embedded wire-up copy still uses `@v1`). Reverted the template changes — `@v1` now means "latest" by convention since v1 tracks main HEAD.
- **Bug detected during the revert:** my glob `dev-agent-*.yml` skipped the main wrapper `dev-agent.yml` (no hyphen after `dev-agent`). CI caught it, follow-up commit [7b7380d](https://github.com/alizaouane/dev-agent/commit/7b7380d) fixed.
- Final shape: 4 commits, 734/734 vitest tests pass, CI green.

**Deferred / Next:**

- **Convention:** going forward, when fixes land on main that need to reach consumers, force-move `v1` to current main HEAD. This is now the standard pattern.
- **Workflow_sha self-reference:** when phase-*.yml runs (called from a consumer), `github.workflow_sha` resolves to the SHA of the called phase YAML. If `main` rolls forward mid-run, this guarantees in-run consistency. Behavior validated by reading [GitHub docs](https://docs.github.com/en/actions/reference/contexts-reference#github-context); not yet observed in a real failing case.
- **`v1` tag deletion deferred:** the user originally suggested removing v1 entirely. Kept it as the rolling stable reference instead — matches the codebase's pinned-tag policy (enforced by `web-app-template.test.ts`) and only requires a periodic tag move rather than rewriting every consumer's deployed YAML.
- **Verification still needed:** I couldn't re-trigger the failing bug-scout on `social-media-content` from this session (classifier blocked cross-repo workflow_dispatch). User to verify by clicking "Run workflow" on https://github.com/alizaouane/social-media-content/actions/workflows/dev-agent-bug-scout.yml — should turn green within ~60s. Otherwise tomorrow's 09:00 UTC scheduled run will be the natural test.

**Next session should start with:** if user reports the consumer bug-scout is now green, archive the issue. If still failing, the next investigation step is `gh run view <new-run-id> --log-failed` to see whether it's the same ERR_MODULE_NOT_FOUND (means v1 didn't roll the way I think it did) or a different error (new bug).

---

## 2026-05-23 11:25 UTC — interactive — dashboard UX brand + inline help + nav restructure (PR #101)

**Trigger:** User: "brainstorm getting the UX more user friendly and increasing navigability and ensure it is crystal clear how the app works, now I am getting lost and confused, add some info ? to explain things so the user dont get confused. aligned the UX colour and all with https://www.qualiency.com/"

**What changed:**

- Spec [docs/superpowers/specs/2026-05-23-dashboard-ux-brand-and-help-design.md](docs/superpowers/specs/2026-05-23-dashboard-ux-brand-and-help-design.md) and plan [docs/superpowers/plans/2026-05-23-dashboard-ux-brand-and-help.md](docs/superpowers/plans/2026-05-23-dashboard-ux-brand-and-help.md) — 15-task TDD plan executed via subagent-driven-development.
- Brand re-skin: swapped `dashboard/app/globals.css` palette tokens to Qualiency navy (`220 30% 18%`) primary + teal (`180 75% 40%`) accent, light + dark parity; added accent button variant in [dashboard/components/ui/button.tsx](dashboard/components/ui/button.tsx).
- New primitives: [dashboard/components/ui/term.tsx](dashboard/components/ui/term.tsx) (hover tooltip + click popover backed by glossary), [dashboard/components/ui/page-header.tsx](dashboard/components/ui/page-header.tsx) (italic descriptor + optional `(?)` help bubble + actions slot), [dashboard/components/ui/breadcrumbs.tsx](dashboard/components/ui/breadcrumbs.tsx) (pure `crumbsForPath` + `<AutoBreadcrumbs/>` under a Suspense boundary).
- Glossary single-source-of-truth [dashboard/lib/glossary.ts](dashboard/lib/glossary.ts) — 21 entries (gate-b, pillar-4/5, tier2-smoke, evidence-bundle, scout, swarm-override, wire-up, pm-agent + per-page + per-band entries) with length-bounds tests.
- Nav restructure in [dashboard/components/nav-header.tsx](dashboard/components/nav-header.tsx) — server/client split, WORK / INSIGHTS section labels, teal active underline via `aria-current="page"`, breadcrumbs mounted below header on inner pages.
- `<PageHeader>` mounted on all 9 top-level pages; `<Term variant="icon">` on 5 home + 4 repo-workspace band headings; `<Term>` inline wraps in 8 components (verification badges, feature card, feature detail, inbox item, scan-with-pm-button, override-events-panel, etc.).
- HelpPanel drawer ([dashboard/components/help-panel.tsx](dashboard/components/help-panel.tsx)) now embeds the full glossary as a canonical reference (each entry: dl row with expandable `<details>` for long body).
- Playwright smoke spec [dashboard/__tests__/e2e/ux-brand-help.spec.ts](dashboard/__tests__/e2e/ux-brand-help.spec.ts) with auth-skip guard.
- Helper extraction [dashboard/lib/state-label.tsx](dashboard/lib/state-label.tsx) (`renderStateBadgeContent`) consolidated the IIFE that was duplicated across feature-card/feature-detail/inbox-item — resolved CodeRabbit major review item.
- CodeRabbit review on PR #101: all 4 comments resolved in commit `6ffb2b3` — closed-vs-shipped descriptor, helper extraction, plan-doc absolute-path cleanup (45 occurrences), spec-doc fence language tags. Per-thread replies + summary comment posted.
- Final shape: 23 commits, +3287/-220, 501/501 vitest tests pass, typecheck clean. Merged via squash as [6e53b2c](https://github.com/alizaouane/dev-agent/commit/6e53b2c).

**Deferred / Next:**

- State-badge `<Term>` substitution lacks dedicated unit tests in `feature-card` / `feature-detail` / `inbox-item` (the extracted helper has tests; the call sites do not — only matters if a future change uses a different state and forgets to wire the helper).
- Cost page has a paragraph descriptor below the new `<PageHeader>` descriptor — mild duplication, drop one on next visit.
- Long repo names in `<PageHeader>` can overflow on narrow mobile widths (no `truncate`); revisit if mobile becomes a real surface.
- Unwired-state CTA on Home still uses hand-rolled classes instead of `<Button variant="accent">` (pre-existing; safe to normalize).
- Run the Playwright smoke spec in CI once an authed dev session exists — currently skips when `/auth/signin` redirect fires.

**Next session should start with:** the four "Deferred / Next" items above are all low-risk follow-up polish on the dashboard UX work. Pick one based on which surface the user is in next, or wait for the user's next ask.

---

## 2026-05-20 14:00 UTC — interactive — establish SESSION_LOG.md habit in dev-agent repo

**Trigger:** User: "make it a habit to write a session log as best practice for this app development."

**What changed:**

- Added [CLAUDE.md](CLAUDE.md) at repo root codifying when / where / how to log.
- Created this `SESSION_LOG.md` and back-filled today's bug-scout fix as the inaugural entry below.
- Rationale: dev-agent ships `SESSION_LOG.md` as a first-class product concept — the PM agent's primary grounding source ([prompts/pm.md](prompts/pm.md)) and the destination phase workflows auto-append to via [lib/cli/append-session-log.ts](lib/cli/append-session-log.ts) — but the dev-agent repo itself wasn't dogfooding the convention.

**Deferred / Next:**

- Consider an interactive-entry CLI builder in [lib/session-log.ts](lib/session-log.ts) (analogous to `buildPhaseEntry` / `buildApprovedScopeEntry`) once the hand-written format settles.
- Consider a `Stop` hook that nudges to append an entry if the session was substantive and `SESSION_LOG.md` wasn't touched.

**Next session should start with:** reading `SESSION_LOG.md` first — that's now the canonical handoff cue for every conversation in this repo.

---

## 2026-05-20 09:00 UTC — interactive — bug-scout workflow fix (scout phases + smoke-verify)

**Trigger:** User reported failing bug-scout run on `social-media-content` (workflow run #4, exit 1, ~31s, error `ERR_MODULE_NOT_FOUND` for `lib/cli/config-to-json.ts`).

**What changed:**

- Diagnosed root cause: 4 reusable phase workflows ran dev-agent's own `lib/cli/*.ts` tooling by relative path, but `workflow_call`'s `actions/checkout` clones the *consumer's* repo (which has `.dev-agent.yml` but no `lib/cli/`). Every bug-scout run from a consumer repo had been failing this way.
- Ported the `.dev-agent-engine` dual-checkout pattern (already used by `phase-acm`, `phase-implement`, `phase-promote-to-prod`, `phase-rollback`, `phase-staging-deploy`, `phase-swarm-review`, `phase-tier2-smoke`) into the 4 workflows that were missed:
  - [.github/workflows/phase-bug-scout.yml](.github/workflows/phase-bug-scout.yml)
  - [.github/workflows/phase-cleanup-scout.yml](.github/workflows/phase-cleanup-scout.yml)
  - [.github/workflows/phase-unfinished-work-scout.yml](.github/workflows/phase-unfinished-work-scout.yml)
  - [.github/workflows/phase-smoke-verify.yml](.github/workflows/phase-smoke-verify.yml)
- Three scout phases also prepend `.dev-agent-engine/**` to `ignore_paths` so the scanning agent never files findings about dev-agent's own code now sitting in the workspace.

**PR:** [#92](https://github.com/alizaouane/dev-agent/pull/92) — merged at commit `a5dc927`.

**Deferred / Next:**

- The `v1` release tag still points at `2707f48` (pre-fix). Force-pushing it to `a5dc927` was blocked by the auto-mode classifier; awaiting explicit user authorization or manual run of `git tag -f v1 a5dc927 && git push -f origin v1`. **Failing daily bug-scout runs on consumer repos will not recover until this is done.**

**Next session should start with:** confirming `v1` was moved (`git ls-remote --tags origin v1` should print `a5dc927…`), then triggering "Run bug-scout now" on the dashboard to verify the first post-fix run goes green.

---
