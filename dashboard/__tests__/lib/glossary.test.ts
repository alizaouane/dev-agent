import { describe, it, expect } from 'vitest';
import { GLOSSARY, type GlossaryEntry } from '@/lib/glossary';

describe('GLOSSARY', () => {
  it('has at least one entry', () => {
    expect(Object.keys(GLOSSARY).length).toBeGreaterThan(0);
  });

  it('every entry has non-empty label, short, long', () => {
    for (const [key, entry] of Object.entries(GLOSSARY)) {
      expect(entry.label, `${key}.label`).toBeTruthy();
      expect(entry.short, `${key}.short`).toBeTruthy();
      expect(entry.long, `${key}.long`).toBeTruthy();
    }
  });

  it('every `short` is <= 90 characters', () => {
    for (const [key, entry] of Object.entries(GLOSSARY)) {
      expect(entry.short.length, `${key}.short length`).toBeLessThanOrEqual(90);
    }
  });

  it('every `long` is between 80 and 600 characters', () => {
    for (const [key, entry] of Object.entries(GLOSSARY)) {
      expect(entry.long.length, `${key}.long length`).toBeGreaterThanOrEqual(80);
      expect(entry.long.length, `${key}.long length`).toBeLessThanOrEqual(600);
    }
  });

  it('every optional `link` is a non-empty string when present', () => {
    for (const [key, entry] of Object.entries(GLOSSARY) as Array<[string, GlossaryEntry]>) {
      if (entry.link !== undefined) {
        expect(entry.link, `${key}.link`).toMatch(/^.+/);
      }
    }
  });

  it('contains the required v1 terms', () => {
    const required = [
      'gate-b', 'pillar-4', 'pillar-5', 'tier2-smoke', 'evidence-bundle',
      'scout', 'swarm-override', 'wire-up', 'pm-agent',
      'needs-you-now', 'in-motion', 'verification-posture',
      'recently-shipped', 'pm-proposes',
      'home-page', 'repos-page', 'intent-page', 'pipeline-page',
      'proposals-page', 'activity-page', 'cost-page',
    ];
    for (const k of required) {
      expect(GLOSSARY).toHaveProperty(k);
    }
  });
});
