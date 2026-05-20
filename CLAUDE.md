# CLAUDE.md — dev-agent repo

Conventions Claude reads on every session in this repo. Keep this file
short. Codify habits, not opinions; point at code rather than restating it.

## Session logging is the habit

This repo has a top-level [SESSION_LOG.md](SESSION_LOG.md). **Before
ending any substantive interactive session, append an entry.**

Dev-agent's PM agent treats `SESSION_LOG.md` as its primary grounding
source (see [prompts/pm.md](prompts/pm.md)), and the product's phase
workflows auto-append entries to consumer repos — this repo dogfoods
the same convention. The log is the canonical "what happened" record;
git history shows _what_ changed but not _why_ or _what's next_.

### When to log

Log when the session:

- changed code, config, infra, or workflow
- diagnosed a bug (even without a fix yet — the diagnosis is the artifact)
- opened or merged a PR, moved a tag, cut a release
- made a meaningful decision (architecture, scope, deferred work)

Skip:

- pure clarifying-question turns
- one-shot lookups that produced no change or decision
- trivial answers ("yes that file exists")

### Where to log

[SESSION_LOG.md](SESSION_LOG.md) at the repo root. Newest entries go
directly under the `# Session Log` H1 — match the layout produced by
`prependEntry()` in [lib/session-log.ts](lib/session-log.ts) so a
phase-workflow auto-append and a hand-written interactive entry land
in the same shape.

### Entry format

```markdown
## YYYY-MM-DD HH:MM UTC — <kind> — <one-line title>

**Trigger:** <what made this session happen>

**What changed:** <bullets or short paragraph; link PRs / commits where they exist>

**Deferred / Next:** <bullets — optional>

**Next session should start with:** <required handoff cue>

---
```

`<kind>` is one of:

- `interactive` — human + Claude dev session (written by hand).
- `phase-<name>` — automated phase workflow (emitted by
  [lib/cli/append-session-log.ts](lib/cli/append-session-log.ts)).
- `user-approved scope` — dashboard approve action (emitted by
  `buildApprovedScopeEntry` in [lib/session-log.ts](lib/session-log.ts)).

### How to append

Edit `SESSION_LOG.md` directly. Target the H1 line plus its trailing
blank line in `old_string` so the new entry inserts under the H1, not
above it. The "Next session should start with" line is the most-loaded
field — the PM agent and the next dev-session both read it first.
