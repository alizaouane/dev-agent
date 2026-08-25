# Stories

Sharded story files, one directory per epic:

    docs/stories/epic-1-onboarding/1.1-account-creation.md

Created by `/shard` (PO persona) and completed by `/story` (SM persona), from
`~/.bmad/templates/story.template.md`.

A story file is **self-contained**: it embeds the architecture excerpts it needs
rather than linking to them, so a Dev session can load only CLAUDE.md and this
one file. Sized for 30–90 minutes of agent time — if it keeps growing during
implementation, it was under-sharded; pause and split it.

Status: `Draft` → `Approved` → `InProgress` → `Review` → `Done`, plus
`Blocked`. One story per session; one branch, one worktree.
