# Project kit

This project resolves personas, templates, and checklists from the canonical kit
at `~/.qualiency-dev-standard/` (Operating Standard §7, §18.2 — "copy from your standard kit").

To override one piece for this project, create the file here with the same
relative path and it wins:

    .standard/agents/architect.md        overrides ~/.qualiency-dev-standard/agents/architect.md
    .standard/templates/story.template.md
    .standard/checklists/security-checklist.md

Override rather than fork. A project that copies the whole kit stops inheriting
improvements made to it.

Slash commands come from `~/.claude/commands/` and work in every repo. Add
`.claude/commands/[name].md` only for genuinely project-specific procedures.
