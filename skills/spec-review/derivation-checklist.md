# Derivation review checklist

Run against a sharded story and the spec it was sharded from. Every check gets
a verdict of `pass`, `concern` or `fail`, and a one-sentence note citing the
section it came from.

## D1 — Faithfulness

- **D1.1** Every acceptance criterion in the story traces to a statement in the
  source spec. `fail` on any that does not.
- **D1.2** No acceptance criterion contradicts the source spec. `fail` on a
  contradiction, `concern` on a narrowing the spec did not ask for.
- **D1.3** The story introduces no design content — no architecture, no data
  shape, no interface, no dependency, no policy — that is absent from the
  source spec. **`fail`**, always. This is the check the whole mode exists for:
  the remedy is to push the content up into the spec, re-approve the spec, and
  approve the story against it. Do not record it as a `concern`, and do not
  accept "it is obviously implied".

## D2 — Testability

- **D2.1** Every acceptance criterion states an observable outcome. `fail` on
  one that cannot be checked without reading the implementation.
- **D2.2** Each criterion is a `- [ ]` checkbox bullet, so
  `extractAcceptanceCriteria` can see it. `fail` otherwise.

## D3 — Resolvability

- **D3.1** Every path in the story's Files to Touch section resolves on the
  default branch, by the same Create / Modify / Tests rules the spec mode
  applies. `fail` on a mismatch.
- **D3.2** The story's `Source spec:` line names a path that exists on the
  default branch. `fail` otherwise.

## D4 — Size

- **D4.1** The story is deliverable in one pull request. `concern` when it
  reads like two.
