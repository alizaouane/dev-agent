import { describe, it, expect } from 'vitest';
import { partitionRepoPipeline, configuredPillars } from '@/lib/dashboard/repo-workspace';
import type { FeatureItem } from '@/lib/pipeline';

const item = (state: FeatureItem['state'], age: number): FeatureItem => ({
  repo: 'a/b',
  issue_number: Math.floor(Math.random() * 1000),
  title: 't',
  state,
  age_seconds: age,
  last_telemetry: null,
  blockers: [],
  html_url: 'x',
});

describe('partitionRepoPipeline', () => {
  it('splits items into in-flight, recently-shipped (14d), and other', () => {
    const items = [
      item('state:implementing', 1000),
      item('state:done', 3 * 24 * 3600),
      item('state:done', 30 * 24 * 3600),
    ];
    const p = partitionRepoPipeline(items);
    expect(p.inFlight.length).toBe(1);
    expect(p.recentlyShipped.length).toBe(1);
  });
});

describe('configuredPillars', () => {
  it('marks gate_b, audit_p4, evidence_p2 as universal', () => {
    const pillars = configuredPillars({ workflows: [] });
    expect(pillars.gate_b).toBe(true);
    expect(pillars.audit_p4).toBe(true);
    expect(pillars.evidence_p2).toBe(true);
  });

  it('marks risk_p5 as opt-in based on workflow presence', () => {
    expect(configuredPillars({ workflows: [] }).risk_p5).toBe(false);
    expect(
      configuredPillars({ workflows: ['.github/workflows/dev-agent-risk-audit.yml'] }).risk_p5,
    ).toBe(true);
  });

  it('marks smoke_p7 as opt-in based on workflow presence', () => {
    expect(configuredPillars({ workflows: [] }).smoke_p7).toBe(false);
    expect(
      configuredPillars({ workflows: ['.github/workflows/dev-agent-tier2-smoke.yml'] }).smoke_p7,
    ).toBe(true);
  });
});
