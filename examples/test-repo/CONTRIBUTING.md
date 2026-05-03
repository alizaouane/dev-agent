# Contributing

This is a synthetic dev-agent test consumer. Edits land here only via the dev-agent agentic pipeline triggered from the parent repo (alizaouane/dev-agent).

## Local development

The mock commands are wired through `.dev-agent.yml`:

- `npm test` → echoes "mock test"
- `npm run typecheck` → echoes "mock typecheck"
- `npm run build` → echoes "mock build"

These are placeholders by design — they exercise the engine's flow without running real toolchains.

## Submitting changes

Open an issue in alizaouane/dev-agent describing the change you'd like the dev-agent to make here. The harness will spec, scope, implement, and ship it.
