---
name: tier2-smoke
description: Use after staging-deployed for any feature that touches a UI route. Drives the deployed app via Playwright using selectors derived from the spec's acceptance criteria — catches Potemkin interfaces (UIs that render but don't wire onClick / network calls) that stdout smoke-verify cannot.
user-invocable: false
---

# tier2-smoke

Pillar 7 of the industry-grade verification architecture. Runs in `state:tier2-smoke`, between `state:staging-deployed` and `state:ready-to-promote`. Catches the silent-failure class that stdout-reading smoke-verify cannot.

## Inputs

- `<staging_url>` — the URL of the freshly-deployed staging environment
- `<spec>` — the spec being verified (wrapped in `<untrusted_content>`)
- `<acm_manifest>` — for surfacing criterion ids in the verification bundle
- `<diff>` — `git diff <base>...<head>` (wrapped) — used to scope the probe to changed routes
- `<config>` — `.dev-agent.yml` (`audit_skills.tier2_smoke`)

## Context isolation

This skill runs as a **separate sub-agent with its own clean context** — never the implement-agent's transcript. Lessons from Replit Agent 3 + Cognition: verification with shared context inherits the implementer's confirmation bias.

## Behavior

1. Generate (or retrieve from `audit_skills.tier2_smoke.target_routes`) the list of UI routes touched by the diff.
2. For each route, derive Playwright selectors from the spec's acceptance criteria. Selector authoring follows ARIA-first discipline (`getByRole`, `getByLabel`, `getByText`).
3. For each criterion that maps to UI behavior (linker decides; the LLM only invokes `clickable`, `visible`, `equals`, `matches` style assertions), assert it via Playwright.
4. Capture: rendered HTML for each route, server stdout/stderr last 500 lines, browser console log, all network requests + responses (URL + status only, never bodies).
5. Bundle into `verification-bundle.tar.gz` and upload as a workflow artifact (also surface in the PR comment chain).

## Output

```json
{
  "verdict": "pass" | "fail" | "ambiguous",
  "results": [
    {
      "criterion_id": "AC-<n>",
      "route": "<URL path>",
      "assertion": "<human-readable>",
      "result": "pass" | "fail",
      "evidence": "<screenshot path | log excerpt>"
    }
  ],
  "summary": "<markdown for PR comment>"
}
```

## Decision rubric

- Every UI-mapped criterion's assertion passes + zero `console.error` + zero non-target 5xx → `pass`.
- Any UI-mapped criterion fails → `fail`, with the failing criterion ids in `summary`.
- `console.error` non-empty OR unexpected 5xx → `fail` with finding `runtime-error`.
- Probe could not resolve selectors at all (e.g. spec doesn't pin selectors) → `ambiguous`, escalate to operator (the spec linter should have caught this earlier — it's a fallback).

## Cost

Uses `models.tier2_smoke` (default `claude-sonnet-4-6-<dated-snapshot>`). Sonnet because Playwright probe authoring is the single most failure-prone agentic step. Cost cap: `cost_caps.tier2_smoke`.

## Implementation status

Contract here. Prompt in `prompts/tier2-smoke.md`. Phase workflow + Playwright runner land in Step 13.
