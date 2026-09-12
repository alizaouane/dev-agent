# Story-level approval

**Status:** Draft
**Date:** 2026-09-12
**Author:** Ali Zaouane (design), Claude (drafting)

## Problem

Two approvals exist for one decision, and neither system can read the other.

A story file carries `**Status:** Approved`, a markdown line validated by
`standard-check` only for being one of six allowed words. Anyone, or any agent,
can set it. It records no identity, no timestamp, and nothing about what was
approved.

dev-agent carries `<spec>.approval.json`, which binds by SHA-256 to the spec and
plan text and records the review verdict, the number of correction rounds, the
approver and the time. It is what the dispatch gate reads.

The first is a claim. The second is evidence. Today you make both.

The mismatch runs deeper than duplication. In whatsapp-console the real order is
spec first, then shard: `docs/stories/epic-8-agent-reliability/8.1-gate-hardening.md`
carries a `Source spec:` line pointing at
`docs/superpowers/specs/2026-07-09-agent-reliability-program-design.md`, and states
that the story is a 1:1 repackaging of that spec's WS1 section with no new design
content. So one approved program spec shards into several stories, while
dev-agent's model is one spec, one issue, one pull request.

Two facts make spec-only approval insufficient:

1. **Sharding performs analysis.** Writing a spec section as a self-contained
   story surfaces gaps — paths that do not resolve, criteria that cannot be
   tested. When it does, something gets decided, and it gets decided in the
   story, after the spec was approved. The agent implements the story.
2. **Hash-binding a long-lived document to many short-lived units is fragile.**
   Amending a program spec because story six found a gap changes its hash, which
   would invalidate the approval for all eight stories, including those already
   running.

## Decision

Approve the spec once as the design gate. Approve each story as the execution
gate. The two records bind different things and fail independently.

The binding rule is deliberately asymmetric:

- At the moment a story is approved, its source spec **must** already carry a
  clean approval. This is a precondition.
- After that moment the story approval **stands alone**. Dispatch checks the
  story text, and does not require the spec to still be at the version recorded.

That asymmetry is the design. It localises the blast radius of a late discovery:
amending the spec affects only stories not yet approved. The spec records design
lineage; the story is the executable contract and the document the agent reads,
so the story is what the hash must protect.

The spec hash stored in a story approval is evidence, not a live constraint. It
answers which version of the design a story was approved against — the question
worth asking after an incident.

## The two artifacts

`<spec>.approval.json` is unchanged, and gains a `kind` field set to `spec`.

`<story>.approval.json` is new, sits beside the story file, and carries:

| Field | Meaning |
|---|---|
| `schema_version` | Record schema version |
| `kind` | `story` |
| `story_path` | Repo-relative path to the story |
| `story_sha256` | Hash of the story text at approval time |
| `source_spec_path` | The spec the story derives from |
| `source_spec_sha256` | That spec's hash at approval time — evidence, not a constraint |
| `review_verdict` | Verdict of the derivation review |
| `review_rounds` | How many correction rounds it took |
| `approved_by` | Git identity of the approving session |
| `approved_at` | ISO-8601 timestamp |

`kind` is belt-and-braces, not the load-bearing part. The two shapes are already
disjoint: `parseSpecApproval` hard-requires `spec_path` and `spec_sha256` as
non-empty strings (`lib/spec-approval.ts:158-171`), which a story record does not
carry, and it ignores unknown keys. A story record therefore cannot be read
through the spec path today, before any change. `kind` makes that explicit rather
than incidental, and carries into the digest for domain separation.

Every approval already committed predates the field. An absent `kind` reads as
`spec`, so existing records keep working untouched.

**`SPEC_APPROVAL_SCHEMA_VERSION` must not be bumped.** Adding a field that older
readers ignore is reader-compatible. Bumping it makes every newly written
approval refuse with `schema-too-new` on any dashboard deployed before the engine
rolls out (`lib/spec-approval.ts:283-289`) — a self-inflicted outage during the
rollout window.

### What the story hash covers

`story_sha256` is taken over the story **with its `**Status:**` header line
removed**. Nothing else is excluded.

This is forced by the design rather than convenient. The status line is a
projection that dev-agent rewrites as the issue moves, and hashing it would mean
the first projection invalidated the approval the projection was derived from —
`dispatchGateDecision` would refuse with `spec-changed` on every read after
implement started, including the explicitly supported re-dispatch paths
(`lib/cli/verify-approval.ts:11-13`). Excluding it is also the honest rule: the
line is not part of what you approved.

dev-agent must not modify any other line of a story file. Editing anything else,
including other header fields, invalidates the approval, which is the point.

Canonicalisation lives in the shared approval module so the engine, the dashboard
and the workflow-side check cannot disagree about what was hashed.

Hashing mixes `kind` into the digest. Reusing `hashSpecAndPlan` unchanged would
make a story and a planless spec over identical bytes produce the same digest
(`lib/spec-approval.ts:116-122`), which removes the domain separation the NUL
separator exists to provide.

## The approval act

One command, `approve-story`, run by the human. It is a sibling of `approve-spec`
and inherits its standing rule: **it is never run on the user's behalf**, because
`approved_by` records a human's identity against work they authorised.

It writes the approval artifact and stamps `**Status:** Approved` into the story
header in one invocation, and the intake commits both together — matching how
`approve-spec` writes the record and the skill commits it. Neither file is
written without the other, so the two records cannot disagree by construction.

Preconditions, each refusing with its own message:

- The story carries a `Source spec:` line that resolves.
- That spec has a recorded approval whose verdict is `ok`. `concerns` and
  `blocker` do not authorise anything.
- The derivation review's own verdict is `ok`. `approve-spec` already refuses a
  non-`ok` verdict at write time (`lib/cli/approve-spec.ts:75-80`) and this
  mirrors it.
- The story is not already approved at its current hash.

**Design content in the story that is absent from its source spec produces a
non-`ok` derivation verdict**, and therefore a refusal. An earlier draft had the
review merely report it. That is worthless here: the operating model is that the
user approves a reviewer's verdict rather than reading the document, so a finding
nobody reads is not a gate. The remedy is to push the finding up into the spec,
re-approve the spec, and approve the story against it — which is the behaviour
this whole design is trying to produce.

**The artifact is authoritative; the status line is a projection.** A hand-edited
`Status: Approved` with no artifact is still refused, because the gate never reads
the line. The line exists for a human reader and for `standard-check`.

Kept honest from the other direction, dev-agent writes the line as the issue
moves: `InProgress` when implement starts, `Review` when the pull request opens,
`Done` when it merges. The story's lifecycle field stops being maintained by hand
and becomes a projection of the issue state, which removes the second duplication
— the story status and the issue labels tracking the same thing separately.

## The dispatch gate

A story-based issue carries `Story:` in its body where a spec-based issue carries
`Spec:` and `Plan:`. Both are parsed by the existing fence-aware parser, so a path
quoted inside a fenced example is not mistaken for the real reference.

For a story issue the gate checks exactly five things:

1. An approval artifact exists beside the story.
2. Its `schema_version` is one this code understands.
3. Its `review_verdict` is `ok`.
4. Its `story_path` matches the path the issue names.
5. The story text still hashes to `story_sha256`.

It does not read the spec. Each failure produces its own message, because a
refusal without a reason is how a gate becomes something people route around.

The `spec-approval:override` label behaves exactly as it does now.

Any read in this path that fails for a reason other than the file being absent
refuses rather than returning a clean answer. Conflating "could not read" with
"not there" accounted for most of the defects fixed in PRs #160 to #162.

## Changes to dev-agent

1. **Intake gains a second door.** When a story already exists, the brainstorm
   and plan-writing phases are skipped — the document has been written. One
   skill with a branch, not a competing second skill.
2. **A derivation review replaces the adversarial spec review** on that door.
   Lighter question: does this story faithfully carry its slice of an approved
   spec, are its acceptance criteria testable, do its file paths resolve. When it
   finds design content absent from the source spec it **reports that**, so the
   finding can be pushed back into the spec rather than absorbed into the story.
3. **The issue body carries `Story:`**, and the issue gains an `epic:N` label so
   stories from one program stop appearing as unrelated items.
4. **The implement agent reads the story.** `phase-implement` resolves a spec path
   today; it resolves a story path and feeds that as the context bundle. The story
   template already carries Files to Touch, acceptance criteria and embedded
   architecture context.
5. **The picker learns about stories.** Larger than first written, and the parts
   below are all load-bearing:
   - A new `artifacts.stories_dir` config key, defaulting to `docs/stories`.
     There is no existing key that locates a story: `lib/schema.ts:89` defines
     only `specs_dir`, `plans_dir`, `status_file` and `runbooks_dir`, and stories
     live under none of them. This reaches the engine schema, the JSON schema,
     the defaults and the wire-up template.
   - Recursive listing via the git tree API rather than one `getContent` per
     directory. `listFilesInDir` is a call per directory and ORs `unreadable`
     across all of them (`list-spec-plan-files.ts:79-86`); recursing epic folders
     would be N+1 calls and one unreadable epic would mark the whole list short.
   - `dashboard/lib/spec-pairs.ts` and `dashboard/lib/verify-spec-pairs.ts`.
     The picker's `approved` flag is not set by the lister — it is re-derived by
     `spec-pairs.ts:161` and re-verified by `verify-spec-pairs.ts:224-243`
     through `parseSpecApproval` and `dispatchGateDecision` with spec semantics.
     An approved story would render **unapproved** without this. `specSlug`,
     `titleFromSlug` and `pathFamily` also assume `YYYY-MM-DD-<topic>-design.md`,
     so `8.1-gate-hardening.md` yields a junk title and a meaningless sort, and
     the verdict cache key globs for a plan that does not exist for stories.
6. **Status projection**, as described above.
7. **The workflow-side approval check** resolves story paths too, since it
   deliberately re-derives paths with different code from the dashboard.
8. **Both copies of the approval module change together.**
   `dashboard/lib/spec-approval.ts` must stay byte-identical to
   `lib/spec-approval.ts`, asserted by `tests/unit/spec-approval.test.ts:267-277`.
   The dashboard deploys with `rootDirectory=dashboard/`, so the copy is what
   ships. Any change to the record shape, the gate or `GateReason` lands in both
   in the same commit or the drift test fails.

Unchanged: the spec approval flow, `quick-dev`, the PR autopilot, and the three
dashboard gates.

## Coexistence

Both issue shapes live side by side; the gate branches on which line the body
carries. Repositories with no `docs/stories` tree are unaffected, as are the five
repositories not wired to dev-agent.

No backfill. whatsapp-console has over a hundred story files, none with approval
artifacts and most already Done. Only newly approved stories get a record, so
adoption is per-story rather than a migration.

One kit change: the story template has no `Source spec:` field — story 8.1 added
it by hand. That line is now load-bearing, read by both the derivation review and
the approval command, so it becomes a template field. One line, reaching all
repositories that use the template.

## Acceptance criteria

Checkbox bullets, because `extractAcceptanceCriteria` matches `- [ ]` / `- [x]`
only (`lib/acm.ts:50`) — plain bullets would make this spec's own criteria
invisible to the manifest that is supposed to bind them to tests.

- [ ] AC-1: A story approval record is written beside the story carrying `kind`
      `story`, the story hash, the source spec path and that spec's hash at
      approval time.
- [ ] AC-2: Approving a story refuses, with a distinct message each, when the
      story has no resolving `Source spec:` line, when that spec's approval
      verdict is not `ok`, when the derivation verdict is not `ok`, or when the
      story is already approved at its current hash.
- [ ] AC-3: Approving a story writes the artifact and stamps `Status: Approved`
      in one invocation; neither file is written without the other.
- [ ] AC-4: A story whose source spec is amended after approval still dispatches.
- [ ] AC-5: A story edited after approval is refused at dispatch.
- [ ] AC-6: Rewriting only the `**Status:**` line does not invalidate the
      approval, and editing any other line does.
- [ ] AC-7: A story with `Status: Approved` and no approval artifact is refused
      at dispatch.
- [ ] AC-8: A story approval cannot be read through the spec code path, nor a
      spec approval through the story code path.
- [ ] AC-9: A story and a planless spec over identical text produce different
      digests.
- [ ] AC-10: Each of the five gate checks fails independently with its own
      message.
- [ ] AC-11: A read failing for any reason other than absence refuses rather
      than returning a clean answer.
- [ ] AC-12: An approved story nested under an epic directory is listed by the
      picker **and offered as dispatchable**, with a readable title and a
      correct sort position.
- [ ] AC-13: The picker resolves stories from `artifacts.stories_dir` and
      renders a partially unreadable tree as short rather than as empty.
- [ ] AC-14: The derivation review returns a non-`ok` verdict when the story
      contains design content absent from its source spec, and approval is
      refused.
- [ ] AC-15: dev-agent writes the story's status line as the issue moves through
      implementing, pr-review and done, without invalidating the approval.
- [ ] AC-16: The intake's second door skips brainstorming and plan writing when
      a story already exists, and files an issue carrying `Story:` and an
      `epic:N` label.
- [ ] AC-17: The implement workflow resolves a story path and feeds the story as
      the context bundle.
- [ ] AC-18: Both copies of the approval module remain byte-identical.
- [ ] AC-19: `SPEC_APPROVAL_SCHEMA_VERSION` is unchanged, and an approval record
      written without `kind` is still read as a spec approval.

## Testing

Test-first throughout. Three tests carry the design:

- **AC-4** encodes the asymmetry. If someone later "tightens" the gate to re-check
  the spec, it fails and says why.
- **AC-5** is its converse and the reason the hash exists.
- **AC-6** is the pair that the independent review showed were in contradiction
  before it ran: the status line must be rewritable without invalidating the
  approval, and every other line must not be. Get this wrong in either direction
  and either the projection breaks every story or the hash protects nothing.

The remaining criteria each get a test. AC-7 is where a bug is most likely, since
it proves the status line is decorative to the gate.

## Out of scope

- Production promotion, which remains unimplemented and is tracked separately.
- Merging the story and spec into one document. Sharding decomposes a program;
  the two are not the same object.
- Removing the status line, which is the only lifecycle record in repositories not
  wired to dev-agent.

## Risks

- **The derivation review is new and unproven.** If it is too lenient the story
  gate adds ceremony without catching drift; too strict and it blocks faithful
  stories. It should be calibrated against existing epic-8 stories before being
  relied on.
- **Approval volume rises** with story count. If a program's stories are routinely
  amended at approval time, that is evidence the spec was too thin, and the
  signal should push work back upstream rather than be absorbed.
- **Rollout hazard on repositories pinned to today's engine.** `phase-implement`
  already greps the issue body for any `docs/**/*.md` that exists on disk
  (`phase-implement.yml:362`), so a `Story:` issue reaching an old engine
  resolves the story as `SPEC_PATH`, reads the story approval, and refuses as
  `malformed`. Fail-closed, which is right, but the operator sees a misleading
  message. The coexistence section assumes both shapes are understood everywhere
  and that is only true once the engine rolls out.
- **`spec-approval:override` now overrides story approvals** under a name that
  says otherwise. It is the on-the-record escape hatch, so the name being wrong
  is an auditing wart rather than a cosmetic one.
- **The kit's conformance check walks `docs/stories/**/*.md`**
  (`check.sh:94`). Approval artifacts are `.json` and are skipped, but any future
  markdown sidecar beside a story would be required to carry a Status line.
