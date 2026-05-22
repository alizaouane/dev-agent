import { describe, it, expect } from 'vitest';
import {
  extractAnchors,
  decodeAnchor,
  summarizeOverride,
  type DevAgentEventLike,
} from '../../lib/events-scrape';

const buildEvent = (overrides: Partial<DevAgentEventLike> = {}): DevAgentEventLike => ({
  ts: '2026-05-22T10:00:00Z',
  run_id: '12345',
  issue: 42,
  phase: 'phase-pr-review',
  event: 'override.applied',
  payload: { override_type: 'swarm-override', actor: 'alice', reason: 'false positive' },
  ...overrides,
});

const encode = (e: DevAgentEventLike): string =>
  Buffer.from(JSON.stringify(e), 'utf8').toString('base64');

const wrap = (b64: string): string => `audit comment body\n\n<!-- dev-agent:event:b64 ${b64} -->`;

describe('extractAnchors', () => {
  it('finds a single anchor in a comment body', () => {
    const b64 = encode(buildEvent());
    const found = extractAnchors(wrap(b64));
    expect(found).toEqual([b64]);
  });

  it('finds multiple anchors when a comment was edited to fix a typo', () => {
    const a = encode(buildEvent({ payload: { override_type: 'swarm-override', actor: 'alice', reason: 'fp' } }));
    const b = encode(buildEvent({ payload: { override_type: 'swarm-override', actor: 'alice', reason: 'false positive' } }));
    const body = `${wrap(a)}\n\nedit: ${wrap(b)}`;
    expect(extractAnchors(body)).toEqual([a, b]);
  });

  it('ignores pre-#96 unencoded anchors (no :b64 suffix)', () => {
    const body = '<!-- dev-agent:event {"ts":"2026-05-20T10:00:00Z"} -->';
    expect(extractAnchors(body)).toEqual([]);
  });

  it('ignores unrelated HTML comments', () => {
    const body = '<!-- vercel:deploy abc -->\n<!-- prettier-ignore -->';
    expect(extractAnchors(body)).toEqual([]);
  });

  it('returns empty array for empty / whitespace-only body', () => {
    expect(extractAnchors('')).toEqual([]);
    expect(extractAnchors('   \n  \n')).toEqual([]);
  });
});

describe('decodeAnchor', () => {
  it('round-trips a valid override.applied event', () => {
    const original = buildEvent();
    const decoded = decodeAnchor(encode(original));
    expect(decoded).toEqual(original);
  });

  it('returns null for non-base64 input', () => {
    expect(decodeAnchor('!!! not base64 !!!')).toBeNull();
  });

  it('returns null for base64 that decodes to invalid JSON', () => {
    const b64 = Buffer.from('not json', 'utf8').toString('base64');
    expect(decodeAnchor(b64)).toBeNull();
  });

  it('returns null for JSON missing required fields', () => {
    const b64 = Buffer.from(JSON.stringify({ ts: '2026-01-01T00:00:00Z' }), 'utf8').toString('base64');
    expect(decodeAnchor(b64)).toBeNull();
  });
});

describe('summarizeOverride', () => {
  it('narrows an override.applied event correctly', () => {
    const e = buildEvent();
    const s = summarizeOverride(e);
    expect(s).toEqual({
      ts: e.ts,
      issue: e.issue,
      actor: 'alice',
      reason: 'false positive',
      override_type: 'swarm-override',
    });
  });

  it('returns null for non-override event types', () => {
    const e = buildEvent({ event: 'cost.snapshot', payload: { total: 10, budget: 50 } });
    expect(summarizeOverride(e)).toBeNull();
  });

  it('returns null when override.applied payload is missing required fields', () => {
    const e = buildEvent({ payload: { override_type: 'swarm-override' } as any });
    expect(summarizeOverride(e)).toBeNull();
  });
});
