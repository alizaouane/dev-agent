---
name: elicit
description: Push a just-written section to be better. Use when a section of a spec, plan, or PM scope feels first-draft — surfaces missing edge cases, hidden assumptions, weaker framings, adversarial perspectives. Invoked from start-feature Phase 1/2 per-section, or stand-alone against any document the user names. Returns control to the caller cleanly when the user types `x`.
user-invocable: false
---

# elicit

Adversarial refinement of a just-written piece of content. Presents a numbered menu of 5 elicitation methods drawn from a 69-method registry, runs the chosen method against the section content, and re-presents the menu until the user types `x` to proceed. Then returns the enhanced content to the caller.

**Announce at start:** "Using `elicit` to refine [section name]."

## When to invoke

This skill is INDIRECT-INVOCATION only. Two entry points:

1. **From `start-feature` Phase 1** — after the PM agent writes the Agreed scope, before handoff to Phase 2. The Agreed scope often hides assumptions about what's "in" vs "out". One round of `elicit` surfaces them cheaply.
2. **From `start-feature` Phase 2 per-section** — after each major section is drafted (Context, Acceptance Criteria, Architecture, Edge cases, Testing strategy). The Phase 2 brainstorming pattern says "scale each section to its complexity"; `elicit` is the lever for that scaling.

**Do NOT activate when:**
- The user hasn't just written something — `elicit` is a refiner, not a generator
- The content is a 3-line trivial-work spec — overkill
- The parent skill is mid-decision (e.g. Phase 0 sanity checks, Phase 4 issue filing) — `elicit` is for content, not workflow

## Contract with the caller

This is the single most important property of this skill: **it always returns control on `x`.** No terminal state advances the parent's workflow. If you (the LLM) find yourself thinking "the user has refined this enough, let me move on to the next section" — STOP. Re-present the 1-5/r/a/x menu until the user explicitly types `x`.

```
Input from caller:
  - section_name (str) — the human-readable name of what's being refined
  - section_content (str) — the current draft of the content to refine
  - context (str, optional) — surrounding context the methods may need

Output to caller:
  - enhanced_content (str) — the final version after the user typed `x`
  - applied_methods (list[str]) — the names of methods the user accepted
```

The caller's TodoWrite list does NOT change while this skill runs. The caller's todo for the current section stays `in_progress` until this skill returns.

## Flow

### Step 1 — Load the method registry

Read `methods.csv` (sibling of this SKILL.md). The CSV has columns:

| column | meaning |
|---|---|
| `num` | stable identifier (1..69) |
| `category` | grouping: advanced / collaboration / competitive / core / creative / framing / learning / philosophical / research / retrospective / risk / technical |
| `method_name` | human-readable display name |
| `description` | rich explanation of what the method does, when to use it, why it's valuable |
| `output_pattern` | flexible flow guide using arrows (e.g. "paths → evaluation → selection") |

### Step 2 — Smart-select 5 methods for this section

Analyze the section content + context. Consider:
- **Content type** — Is it a problem statement (use `core` + `framing`)? An architecture sketch (use `technical` + `risk`)? An AC list (use `risk` + `core`)? A creative pitch (use `creative` + `collaboration`)?
- **Visible weak spots** — Does it hand-wave at edge cases (use `risk`)? Does it assume reader context (use `framing`)? Does it skip the "why" (use `core`)?
- **Coverage diversity** — Include at least one method from a category the section is currently weak in, not just methods from categories it already touches.

Select 5 methods that genuinely fit. Don't always pick the same five — section-specific selection is the whole point.

### Step 3 — Present the menu

Display the menu in this exact format:

```
**Refine [section_name]**

Choose a number (1-5), [r] to Reshuffle, [a] List All, or [x] to Proceed:

1. [Method Name] — [one-line plain-English summary]
2. [Method Name] — [...]
3. [Method Name] — [...]
4. [Method Name] — [...]
5. [Method Name] — [...]
r. Reshuffle (pick 5 new methods)
a. List all 69 methods
x. Proceed (return enhanced content to caller)
```

HALT and wait for the user's input. Do NOT advance on your own.

### Step 4 — Handle the response

**Case 1-5 (numbered selection):**
1. Execute the chosen method against `section_content` using the CSV's `description` as the prompt. Apply the method creatively but stay faithful to its intent.
2. Show the enhanced version of the section. Be explicit about what changed and why.
3. Ask: "Apply this change to the section? (y/n/other)" and HALT.
4. If `y`: replace `section_content` with the enhanced version. Record the method name in `applied_methods`.
5. If `n`: discard the proposed enhancement. `section_content` is unchanged.
6. If other: try your best to follow the user's instructions, then return to step 3 (re-present the menu).
7. **Re-present the same 1-5/r/a/x menu** so the user can stack further refinements.

**Case `r` (reshuffle):**
- Pick 5 new methods using the same smart-selection logic, biasing toward methods you haven't shown yet this session.
- Re-present the menu.

**Case `a` (list all):**
- Print a compact table of all 69 methods grouped by category, with `num` and `method_name`.
- Ask: "Choose any number 1-69, or [x] to return to the smart-selected menu."
- If the user picks a number, execute that method (Case 1-5 flow). If `x`, return to the smart-selected menu.

**Case `x` (proceed):**
- Return `enhanced_content` (the current state of `section_content`) and `applied_methods` to the caller.
- Done. Do NOT continue the loop.

**Case: direct text feedback (not a menu choice):**
- The user is telling you what to fix directly. Apply the change to `section_content`, then re-present the menu.

### Step 5 — Iteration discipline

- Each accepted method modifies `section_content` in place. The next method runs against the modified version, not the original.
- Keep `applied_methods` as an ordered list — the parent skill may surface "this section refined via: [methods]" for traceability.
- If the user repeats the same kind of feedback ("still not edge-case-y enough") after 2-3 rounds, propose: "We've stacked N refinements. Should we accept this version, or roll back to before the last change?" Don't loop forever.

## Failure modes

- **`methods.csv` missing or malformed** → log the error, fall back to a hand-curated 5: `First Principles Analysis`, `Pre-mortem Analysis`, `Stakeholder Lens Rotation`, `Boundary & Edge Case Sweep`, `Critique and Refine`. Re-present the menu with those.
- **User types unrecognized response** → don't guess. Echo back: "I didn't understand `<input>`. Type 1-5, r, a, or x." HALT.
- **Section content empty or trivial** (< 30 chars) → don't refine emptiness. Return immediately to the caller with a note that there was nothing to refine yet.
- **Caller didn't pass `section_name`** → ask once for a label. If unknown, use the literal string "current section".

## Discipline

- One method per round. Don't apply 3 methods to the same content in a single agent turn.
- Surface the change, don't bury it. If the user accepts, they should be able to see exactly what got added or removed.
- Don't propose your own enhancements outside the chosen method. The 69 methods exist to discipline your refinement instincts, not bypass them.
- **Never advance the parent's workflow.** If the user types `x`, you return to the caller. If the user keeps choosing methods, you keep refining. Either is valid; trying to interpret "we should move on" without `x` is not.

## Attribution

The 69 methods in [methods.csv](methods.csv) are ported verbatim from BMAD-METHOD's [`bmad-advanced-elicitation`](https://github.com/bmad-code-org/BMAD-METHOD/tree/main/src/core-skills/bmad-advanced-elicitation) under its MIT license (© 2025 BMad Code, LLC). dev-agent uses the same registry; the orchestration and integration contract (return-to-caller on `x`, no terminal-state advance) are adapted for dev-agent's `start-feature` workflow.
