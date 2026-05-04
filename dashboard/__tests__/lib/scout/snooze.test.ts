import { describe, it, expect, beforeEach } from 'vitest';
import {
  __resetSnoozeStoreForTests,
  isSnoozed,
  partitionBySnooze,
  snoozeProposalId,
  unsnoozeProposalId,
} from '@/lib/scout/snooze';
import type { Proposal } from '@/lib/scout';

const fakeProposal = (id: string, group: 'carry_over' | 'new_idea' = 'carry_over'): Proposal => ({
  id,
  source: 'unfinished_plan',
  group,
  repo: 'q/r',
  title: 'A thing',
  description: 'Whatever',
  url: 'https://example.com',
});

describe('scout/snooze', () => {
  beforeEach(() => {
    __resetSnoozeStoreForTests();
  });

  it('snoozeProposalId marks an id snoozed', () => {
    expect(isSnoozed('alice', 'p1')).toBe(false);
    snoozeProposalId('alice', 'p1');
    expect(isSnoozed('alice', 'p1')).toBe(true);
  });

  it('snoozes are scoped per-user', () => {
    snoozeProposalId('alice', 'p1');
    expect(isSnoozed('alice', 'p1')).toBe(true);
    expect(isSnoozed('bob', 'p1')).toBe(false);
  });

  it('expires entries past the TTL', () => {
    snoozeProposalId('alice', 'p1');
    // Simulate 8 days from now — past the 7-day TTL.
    const past = Date.now() + 8 * 24 * 60 * 60 * 1000;
    expect(isSnoozed('alice', 'p1', past)).toBe(false);
    // Subsequent untimed lookups should also see it as gone (cleanup).
    expect(isSnoozed('alice', 'p1')).toBe(false);
  });

  it('unsnoozeProposalId removes the entry', () => {
    snoozeProposalId('alice', 'p1');
    unsnoozeProposalId('alice', 'p1');
    expect(isSnoozed('alice', 'p1')).toBe(false);
  });

  it('unsnoozeProposalId is idempotent on missing entries', () => {
    expect(() => unsnoozeProposalId('alice', 'never-was')).not.toThrow();
    expect(isSnoozed('alice', 'never-was')).toBe(false);
  });

  it('partitionBySnooze splits into active and snoozed', () => {
    const proposals = [fakeProposal('p1'), fakeProposal('p2'), fakeProposal('p3')];
    snoozeProposalId('alice', 'p2');
    const { active, snoozed } = partitionBySnooze('alice', proposals);
    expect(active.map((p) => p.id)).toEqual(['p1', 'p3']);
    expect(snoozed.map((p) => p.id)).toEqual(['p2']);
  });

  it('re-snoozing the same id is idempotent (Map.set overwrites)', () => {
    snoozeProposalId('alice', 'p1');
    expect(isSnoozed('alice', 'p1')).toBe(true);
    snoozeProposalId('alice', 'p1');
    expect(isSnoozed('alice', 'p1')).toBe(true);
  });
});
