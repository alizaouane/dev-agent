---
description: Abandon an in-flight feature (closes PR if any, archives spec, relabels state:abandoned)
argument-hint: "<issue#> [--reason=<text>]"
allowed-tools: Read Write Bash
---

# /abandon

Cleanly cancels an in-flight feature. Use when an intent is no longer valid (requirement changed, duplicate, etc.).

## Steps

1. Parse `<issue#>` and optional `--reason`.
2. If a linked PR exists (look for `Linked: #<pr>` in issue body or branch named `feature/<slug>` with an open PR), close it with comment "abandoned by /abandon (issue #<issue#>)".
3. If a linked spec file exists at `<artifacts.specs_dir>/<file>.md`, move it to `<artifacts.specs_dir>/abandoned/<file>.md` (creating the directory if needed). Preserves audit trail.
4. Apply `state:abandoned` label, remove all other `state:*` labels.
5. Post a closure comment on the issue: "Abandoned by <gh-user> at <ISO-timestamp>. Reason: <reason or 'unspecified'>."
6. Close the issue.

## Safety

- Always asks for confirmation if the issue currently has `state:promoting` or `state:staging-deployed` (real changes are live; user may want `/rollback` instead).
- Refuses if `state:done` (already shipped).

## Failure modes

- Missing `gh` → bail.
- Missing spec dir → still closes issue, comments "no spec file to archive" warning.

## Implementation note

Fully functional in 1b — read-only-to-shared-state operations.
