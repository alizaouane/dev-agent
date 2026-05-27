---
# PM agent's persistent memory. Edit this file directly — the dashboard
# also lets the PM propose updates after big decisions, but you own the
# final state. Every field is optional.

# What you're trying to do, period. The PM ranks proposals against these.
# Use any keys you want; the structure is just `key: one-line description`.
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
# competitor X" proposal on /proposals — click "Brainstorm in Claude Code"
# to copy a /develop --from-issue <#> command and continue in your
# Claude Code session. Snooze handles noise.
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
