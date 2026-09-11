import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GATE_TRANSITIONS, transitionFor } from '@/lib/gate-transitions';

const SPEC = resolve(__dirname, '../../../skills/orchestrator/SKILL.md');

/** The `/approve` rows of the orchestrator's transition table. */
function specRows(): Array<{ from: string; to: string; phase: string; promote: boolean }> {
  const raw = readFileSync(SPEC, 'utf8');
  const rows: Array<{ from: string; to: string; phase: string; promote: boolean }> = [];
  for (const line of raw.split('\n')) {
    const m = line.match(
      /^\|\s*`(state:[a-z-]+)`\s*\|\s*`?\/approve([^|]*?)`?\s*\|\s*`(state:[a-z-]+)`\s*\|\s*(.*?)\s*\|$/,
    );
    if (!m) continue;
    const dispatch = m[4].match(/dispatch\s+`?phase-([a-z-]+)\.yml`?/);
    if (!dispatch) continue;
    rows.push({
      from: m[1],
      to: m[3],
      phase: dispatch[1],
      promote: m[2].includes('--promote'),
    });
  }
  return rows;
}

describe('gate transitions match the orchestrator spec', () => {
  it('finds the approve rows in the spec, so an empty table cannot pass', () => {
    expect(specRows().length).toBeGreaterThanOrEqual(3);
  });

  it('implements every approve transition the spec documents', () => {
    // The spec is the contract. A row documented here and missing from the
    // code is a dashboard button that flips a label and does nothing, which
    // is how the staging and promote gates shipped inert.
    for (const row of specRows()) {
      const found = transitionFor(row.from, row.promote);
      expect(found, `${row.from} (promote=${row.promote})`).toBeDefined();
      expect(found!.to).toBe(row.to);
      expect(found!.phase).toBe(row.phase);
    }
  });

  it('documents every transition it implements, so the code cannot drift ahead', () => {
    const spec = specRows();
    for (const t of GATE_TRANSITIONS) {
      const match = spec.find((r) => r.from === t.from && r.promote === t.promote);
      expect(match, `${t.from} (promote=${t.promote}) is not in the spec`).toBeDefined();
    }
  });

  it('never resolves a transition the spec does not carry', () => {
    expect(transitionFor('state:done', false)).toBeUndefined();
    expect(transitionFor('state:spec-ready', true)).toBeUndefined();
  });

  it('leaves the state to the workflow when the workflow sets it', () => {
    // phase-staging-deploy ends with `gh issue edit --remove-label
    // state:pr-review --add-label <state:staging-deployed|state:blocked>`.
    // If the dashboard has already applied the success label, the failure
    // path adds state:blocked beside it and the issue carries two.
    expect(transitionFor('state:pr-review', false)!.setsStateHere).toBe(false);
  });

  it('sets the state itself where no workflow does', () => {
    expect(transitionFor('state:spec-ready', false)!.setsStateHere).toBe(true);
    expect(transitionFor('state:ready-to-promote', true)!.setsStateHere).toBe(true);
  });
});
