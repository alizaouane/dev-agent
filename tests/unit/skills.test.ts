import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { EXPECTED_SKILLS, USER_INVOCABLE_SKILLS } from '../../lib/plugin-files';

const skillsDir = resolve(__dirname, '../../skills');

function splitFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error('No frontmatter found');
  return { frontmatter: yaml.load(match[1]) as Record<string, unknown>, body: match[2] };
}

describe('skills/', () => {
  for (const name of EXPECTED_SKILLS) {
    describe(`/${name}`, () => {
      const path = resolve(skillsDir, name, 'SKILL.md');

      it('SKILL.md exists', () => {
        expect(existsSync(path)).toBe(true);
      });

      it('has frontmatter with name matching directory', () => {
        const raw = readFileSync(path, 'utf8');
        const { frontmatter } = splitFrontmatter(raw);
        expect(frontmatter.name).toBe(name);
      });

      it('has a description that says when to use it', () => {
        const raw = readFileSync(path, 'utf8');
        const { frontmatter } = splitFrontmatter(raw);
        expect(typeof frontmatter.description).toBe('string');
        expect((frontmatter.description as string).length).toBeGreaterThan(30);
      });

      it('has the expected user-invocable value', () => {
        const raw = readFileSync(path, 'utf8');
        const { frontmatter } = splitFrontmatter(raw);
        // Most dev-agent skills are internal (invoked by slash commands
        // / workflows, not by the user). `start-feature` is the
        // exception — it auto-activates on user intent in a wired-up
        // consumer repo, so it carries `user-invocable: true`.
        const expected = USER_INVOCABLE_SKILLS.has(name);
        expect(frontmatter['user-invocable']).toBe(expected);
      });

      it('body has at least one H2 section', () => {
        const raw = readFileSync(path, 'utf8');
        const { body } = splitFrontmatter(raw);
        expect(body.split('\n').some((l) => l.startsWith('## '))).toBe(true);
      });
    });
  }

  it('contains exactly the expected skills (no extras)', () => {
    const dirs = readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(dirs).toEqual([...EXPECTED_SKILLS].sort());
  });

  describe('/spec-review', () => {
    // The spec-review skill ships a separate checklist.md alongside its
    // SKILL.md, modeled on BMAD's bmad-create-story pattern. The skill
    // delegates the actual review questions to that file so the checklist
    // can be evolved without rewriting SKILL.md prose.
    const checklistPath = resolve(skillsDir, 'spec-review', 'checklist.md');

    it('ships checklist.md', () => {
      expect(existsSync(checklistPath)).toBe(true);
    });

    it('checklist.md references each required check category', () => {
      const raw = readFileSync(checklistPath, 'utf8');
      // Categories the SKILL.md and start-feature Phase 3.5 documentation
      // promise to enforce. If any of these disappears, the integration
      // contract is broken.
      for (const heading of [
        '## A. Spec structural integrity',
        '## B. Acceptance Criteria quality',
        '## C. Files to Touch quality',
        '## D. Plan ↔ Spec alignment',
        '## E. Disaster prevention',
        '## F. Implementation clarity',
        '## G. Pillar coverage',
      ]) {
        expect(raw).toContain(heading);
      }
    });
  });

  /**
   * Slice one section out of a skill file, bounded at the next `##`/`###`
   * heading that is not inside a fenced code block.
   *
   * Both halves matter. An unbounded slice runs to end of file and reads the
   * wrong section, passing assertions that should fail. A bound that counts
   * headings inside fences stops at the `## TL;DR` in a heredoc and reads
   * less than the section, failing assertions that should pass. This file has
   * both shapes in it.
   *
   * @param raw - The whole skill file.
   * @param heading - The exact heading line the section starts at.
   * @returns The section text, or '' when the heading is absent.
   */
  const section = (raw: string, heading: string): string => {
    const start = raw.indexOf(heading);
    if (start === -1) return '';
    const body = raw.slice(start + heading.length);
    for (const match of body.matchAll(/\n#{2,3} /g)) {
      const fences = (body.slice(0, match.index).match(/^```/gm) ?? []).length;
      if (fences % 2 === 0) return raw.slice(start, start + heading.length + match.index);
    }
    return raw.slice(start);
  };

  describe('/start-feature — the story door', () => {
    // The second intake door: when the work is already a sharded story
    // (written upstream by /shard from an approved program spec), brainstorm
    // and plan-writing are both waste — the document already exists. This
    // door reads the story's `Source spec:` line, confirms that spec carries
    // a clean approval, runs the lighter derivation review instead of the
    // full adversarial spec-review, and files a story-shaped issue.
    const skillPath = resolve(skillsDir, 'start-feature', 'SKILL.md');
    const raw = existsSync(skillPath) ? readFileSync(skillPath, 'utf8') : '';

    it('documents a branch for an already-written story that skips brainstorming and plan-writing', () => {
      expect(raw).toMatch(/already[- ](a[- ])?(written|sharded)\s+story/i);
      expect(raw).toMatch(/skips?\s+(the\s+)?(brainstorm(ing)?|Phase\s*2)/i);
      expect(raw).toMatch(/skips?\s+(the\s+)?(plan[- ]writing|Phase\s*3\b)/i);
    });

    it('names approve-story for the story branch and approve-spec for the spec branch', () => {
      expect(raw).toContain('approve-story');
      expect(raw).toContain('approve-spec');
    });

    it('carries the same never-on-the-users-behalf prohibition for approve-story as for approve-spec', () => {
      expect(raw).toMatch(/never run `approve-story` on the user'?s behalf/i);
      expect(raw).toMatch(/never run `approve-spec` on the user'?s behalf/i);
    });

    it('runs a derivation review rather than the full spec-review on the story branch', () => {
      expect(raw).toMatch(/derivation review/i);
    });

    it('validates the source spec approval by running the real gate, not by testing for a file', () => {
      // Codex, PR #164: Phase S.1 promised to catch an unapprovable source
      // spec BEFORE spending a derivation-review round, but only checked the
      // sidecar existed. A record that is malformed, carries a non-`ok`
      // verdict, names a different spec, names a plan that moved, or has gone
      // stale all passed that check — and `approve-story` then refused after
      // the review had run and the user had been asked to approve. The phase
      // must run the same decision `buildStoryApproval` will, which is
      // `verify-approval` against the source spec.
      const phase = raw.slice(raw.indexOf('### Phase S.1'), raw.indexOf('### Phase S.2'));
      expect(phase).toContain('verify-approval.ts');
      expect(phase).toMatch(/SPEC_PATH=/);
      expect(phase).toMatch(/PLAN_PATH=/);
    });

    it('short-circuits to the handoff when the story is already approved at its current hash', () => {
      // Codex, PR #164: `buildStoryApproval` refuses to re-record an approval
      // whose hash already matches — deliberately, it is AC-2. But Phase S.2
      // invoked `approve-story` unconditionally, so a session that recorded
      // and committed the approval and then died before filing the issue could
      // never reach Phase S.3. Nor could a story a human had already approved.
      // The check is the story-side gate, so it can only pass on an approval a
      // human already recorded: it cannot be used to skip the approval gate.
      const phase = raw.slice(raw.indexOf('### Phase S.1'), raw.indexOf('### Phase S.2'));
      expect(phase).toMatch(/STORY_PATH=[\s\S]{0,300}verify-approval\.ts/);
      expect(phase).toMatch(/(already approved|skip|straight) to Phase S\.3/i);
    });

    it('checks for an issue already filed for this story before creating one', () => {
      // Codex, PR #164: Phase S.3 created an issue unconditionally. The spec
      // door's open-pipeline lookup lives in Phase 1, which this door skips,
      // so re-entering it filed a second issue for the same story — and
      // implement concurrency and branch names are keyed by issue number, so
      // both could dispatch independent agents against one approved story.
      const phase = section(raw, '### Phase S.3');
      expect(phase).toMatch(/gh issue list/);
      // The lookup has to come before the create, not after it.
      expect(phase.indexOf('gh issue list')).toBeLessThan(phase.indexOf('gh issue create'));
    });

    it('canonicalises the story path on both sides of the duplicate lookup', () => {
      // Codex, PR #164: the lookup compared raw lines, so re-entering the door
      // with a `./`-prefixed spelling missed an existing issue written without
      // one and filed a duplicate — which dispatches a second agent against
      // the same approved story. `canonicalStoryPath` covers the gate readers;
      // this shell comparison is its own reader and needs the same rule.
      const phase = section(raw, '### Phase S.3');
      // STORY_PATH itself, so the issue is also FILED in the canonical form.
      expect(phase).toMatch(/STORY_PATH=.*sed[^\n]*\(\\\.\/\)\+/);
      // and the paths pulled out of each candidate issue body.
      expect(phase).toContain('capture(');
      expect(phase).toMatch(/sub\("\^\(\\\\\.\/\)\+"/);
    });

    describe('the duplicate lookup agrees with the other readers of a Story: line', () => {
      // This lookup is a FOURTH reader, after the dashboard parser, the
      // workflow grep and the gate. Rather than assert its text, pull the real
      // jq program out of the skill and run it, so the test tracks behaviour.
      const program = (): string => {
        const phase = section(raw, '### Phase S.3');
        const open = 'EXISTING=$(jq -c --arg want "$STORY_PATH" \'';
        const start = phase.indexOf(open);
        if (start === -1) throw new Error('could not find the duplicate-lookup jq in Phase S.3');
        const end = phase.indexOf('\' <<<"$ISSUES")', start);
        if (end === -1) throw new Error('the duplicate-lookup jq is not terminated');
        return phase.slice(start + open.length, end);
      };

      /** Run the skill's own jq over `issues`, asking after `want`. */
      const lookup = (want: string, issues: unknown[]): string =>
        execFileSync('jq', ['-c', '--arg', 'want', want, program()], {
          input: JSON.stringify(issues),
          encoding: 'utf8',
        }).trim();

      const issue = (over: Record<string, unknown>) => ({
        number: 1,
        url: 'https://example.test/1',
        state: 'OPEN',
        ...over,
      });

      it('finds the issue that names the story', () => {
        const found = lookup('docs/stories/epic-8/8.1-x.md', [
          issue({ body: 'Story: docs/stories/epic-8/8.1-x.md\n\n## TL;DR\n\nreal' }),
        ]);
        expect(found).not.toBe('');
      });

      it('does NOT match a Story: line quoted inside a fenced example', () => {
        // The failure this guards: a spec issue showing a story reference in
        // an example was matched as that story's own issue, so the real one
        // was never filed and the door exited saying it already existed.
        const found = lookup('docs/stories/epic-9/9.1-y.md', [
          issue({
            body: 'Spec: docs/specs/a-design.md\n\nExample:\n\n```\nStory: docs/stories/epic-9/9.1-y.md\n```\n',
          }),
        ]);
        expect(found).toBe('');
      });

      it('matches a ./-prefixed reference written with a tab and a CRLF ending', () => {
        const found = lookup('docs/stories/epic-7/7.1-z.md', [
          issue({ state: 'CLOSED', body: 'Story:\t./docs/stories/epic-7/7.1-z.md  \r\n' }),
        ]);
        expect(found).toContain('CLOSED');
      });

      it('ignores an issue with no body at all', () => {
        expect(lookup('docs/stories/epic-8/8.1-x.md', [issue({ body: null })])).toBe('');
      });

      it('leaves an unpaired fence opener alone, as stripQuotedRegions does', () => {
        // A stray opener must not swallow the canonical reference below it.
        const found = lookup('docs/stories/epic-8/8.1-x.md', [
          issue({ body: '```\nStory: docs/stories/epic-8/8.1-x.md\n' }),
        ]);
        expect(found).not.toBe('');
      });
    });

    it('does not read a truncated issue listing as no issue', () => {
      // The recurring failure this repo keeps closing: a search that could not
      // see something reporting the something is not there. Filing a duplicate
      // on a short listing is exactly that.
      const phase = section(raw, '### Phase S.3');
      expect(phase).toMatch(/(truncat|short|limit)/i);
    });

    it('files a story issue with an unbackticked Story: line alone on its line', () => {
      // Same shape the existing door uses for `Spec:` — see Phase 4's
      // `Spec: ${SPEC_PATH}` — and for the same reason: the dashboard parser
      // (/^\s*Story:\s*(\S+\.md)\s*$/m) and the workflow grep are both
      // end-anchored and both strip/reject quoted regions, so a backticked
      // path would file cleanly and then fail the gate.
      // Scoped to the heredoc that becomes the issue body. A file-wide scan
      // is what this guard used to be, and it failed on the first comment
      // that quoted a `Story:` line in prose — reporting a defect in text
      // that never reaches an issue, which is the wrong file to fix.
      const bodyStart = raw.indexOf('BODY=$(cat <<EOF');
      const body = raw.slice(bodyStart, raw.indexOf('\nEOF\n', bodyStart));
      expect(body).not.toBe('');
      expect(body).toMatch(/^Story: \$\{STORY_PATH\}$/m);
      expect(body).not.toMatch(/`Story: /);
    });

    it("labels the story issue state:spec-ready, kind:<kind>, and epic:<N>", () => {
      expect(raw).toMatch(/--label\s+"state:spec-ready,kind:\$\{KIND\},epic:\$\{EPIC\}"/);
    });

    it('extends the gh label create fallback to the epic: label', () => {
      expect(raw).toMatch(/gh label create\s+"epic:\$\{EPIC\}"/);
    });

    it('states that a story issue carries no Plan: line', () => {
      expect(raw).toMatch(/no `Plan:` line/i);
    });

    it('stops and asks for the epic number if the directory does not match epic-N- pattern', () => {
      // Guard against silent malformation when a story directory doesn't match
      // ^epic-N-...: sed leaves non-matching input unchanged, turning
      // docs/stories/misc-fixes/... into EPIC=misc-fixes. A guard must check
      // EPIC is numeric and stop clearly, because a wrong label is invisible
      // until grouping by epic starts (slice 4).
      expect(raw).toMatch(/\[\[.*EPIC|test.*EPIC/); // shell test condition
      expect(raw).toMatch(/\[0-9\]/); // numeric pattern check
      expect(raw).toMatch(/(ERROR|exit 1|stop)/i); // error/stop action
    });
  });

  describe('/quick-dev', () => {
    // Fast-path skill for trivial work. The SKILL.md must encode the
    // bypass contract: phases 2 / 3 / 3.5 are skipped, the implement
    // agent derives its own task list, and the issue gets the
    // `quick-dev` label so the dashboard can surface the path.
    const skillPath = resolve(skillsDir, 'quick-dev', 'SKILL.md');
    const raw = existsSync(skillPath) ? readFileSync(skillPath, 'utf8') : '';

    it('SKILL.md references the quick-spec template path', () => {
      // The skill must point at templates/quick-spec.template.md
      // (not the full spec template) or the fast path leaks into the
      // heavyweight structure and defeats its own purpose.
      expect(raw).toContain('templates/quick-spec.template.md');
    });

    it('declares the "no plan, no spec-review" contract', () => {
      // The trade-off behind quick-dev is that the engine handles
      // task derivation. If this contract drifts, the start-feature
      // routing (Phase 1.5) becomes incoherent and the implement
      // agent receives ambiguous inputs.
      expect(raw).toMatch(/no\s+(separate\s+)?plan/i);
      expect(raw).toContain('spec-review');
      expect(raw).toMatch(/derives? (its )?own task list/i);
    });

    it('declares that the filed issue carries the quick-dev label', () => {
      // The dashboard's state:spec-ready card surfaces the
      // `quick-dev` label as a "fast path" pill. Without it the
      // approver has no signal that the heavyweight gates were
      // intentionally skipped.
      expect(raw).toContain('quick-dev');
      expect(raw).toContain('state:spec-ready');
    });
  });
});

describe('spec-review derivation mode', () => {
  const root = resolve(__dirname, '../..');
  const skill = readFileSync(resolve(root, 'skills/spec-review/SKILL.md'), 'utf8');
  // Bounded at the next top-level heading. An unbounded slice runs into the
  // spec mode below it, whose text mentions the plan this mode must not ask
  // for — the assertion would then be reading the wrong section.
  const modeStart = skill.indexOf('## Derivation-review mode');
  const modeBody = skill.slice(modeStart + 1);
  const modeEnd = [...modeBody.matchAll(/\n## /g)].find(
    (m) => ((modeBody.slice(0, m.index).match(/^```/gm) ?? []).length % 2) === 0,
  );
  const mode = modeEnd
    ? skill.slice(modeStart, modeStart + 1 + modeEnd.index)
    : skill.slice(modeStart);

  it('declares the mode start-feature Phase S.1 invokes', () => {
    // Codex, PR #164 (P1): the shipped story door told the agent to invoke
    // `dev-agent:spec-review`'s derivation-review mode, and no such mode
    // existed. The spec mode requires a plan, which a story does not have, so
    // the door could not reach a clean verdict at all — it blocked, or invited
    // the agent to invent a review result.
    expect(skill).toContain('## Derivation-review mode');
    expect(mode).toContain('story_path');
    expect(mode).toContain('source_spec_path');
  });

  it('makes design content absent from the source spec a blocker', () => {
    // The verdict word is the entire mechanism: `buildStoryApproval` refuses
    // anything that is not `ok`, and the user approves a verdict rather than
    // reading the document. A finding recorded only in prose is not a gate.
    expect(mode).toMatch(/absent from (the |its )?source spec[^.]*blocker/i);
  });

  it('does not ask a story for a plan', () => {
    // The spec-mode checklist cross-checks acceptance criteria against plan
    // tasks. A mode that inherited that check would emit a blocker on every
    // story.
    expect(mode).not.toContain('plan_path');
  });

  it('ships the checklist the mode loads', () => {
    expect(existsSync(resolve(root, 'skills/spec-review/derivation-checklist.md'))).toBe(true);
  });
});
