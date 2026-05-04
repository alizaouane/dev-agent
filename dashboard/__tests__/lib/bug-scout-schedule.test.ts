import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseScheduleFromYaml,
  applyPresetToYaml,
  cronToPreset,
  readBugScoutSchedule,
  writeBugScoutSchedule,
  BUG_SCOUT_WORKFLOW_PATH,
} from '@/lib/bug-scout-schedule';

const TEMPLATE_YAML = `name: dev-agent · bug-scout

on:
  schedule:
    # Daily 09:00 UTC.
    - cron: '0 9 * * *'
  workflow_dispatch:
    inputs:
      focus_paths:
        type: string

jobs:
  bug-scout:
    uses: alizaouane/dev-agent/.github/workflows/phase-bug-scout.yml@v1
`;

const DISABLED_YAML = TEMPLATE_YAML.replace(
  "    - cron: '0 9 * * *'",
  "    # - cron: '0 9 * * *'  # disabled — only workflow_dispatch fires this workflow",
);

describe('cronToPreset', () => {
  it('maps known cron strings to preset names', () => {
    expect(cronToPreset('0 9 * * *')).toBe('daily');
    expect(cronToPreset('0 9 * * 1-5')).toBe('weekdays');
    expect(cronToPreset('0 9 * * 1')).toBe('weekly');
  });

  it('returns "unknown" for unrecognized cron strings', () => {
    expect(cronToPreset('15 6 * * *')).toBe('unknown');
    expect(cronToPreset('* * * * *')).toBe('unknown');
  });
});

describe('parseScheduleFromYaml', () => {
  it('reads the active cron from a daily preset', () => {
    const r = parseScheduleFromYaml(TEMPLATE_YAML);
    expect(r.preset).toBe('daily');
    expect(r.cron).toBe('0 9 * * *');
  });

  it('reads weekdays preset', () => {
    const yaml = TEMPLATE_YAML.replace("'0 9 * * *'", "'0 9 * * 1-5'");
    const r = parseScheduleFromYaml(yaml);
    expect(r.preset).toBe('weekdays');
    expect(r.cron).toBe('0 9 * * 1-5');
  });

  it('reads weekly preset', () => {
    const yaml = TEMPLATE_YAML.replace("'0 9 * * *'", "'0 9 * * 1'");
    const r = parseScheduleFromYaml(yaml);
    expect(r.preset).toBe('weekly');
    expect(r.cron).toBe('0 9 * * 1');
  });

  it('reports off when the cron line is commented out', () => {
    const r = parseScheduleFromYaml(DISABLED_YAML);
    expect(r.preset).toBe('off');
    expect(r.cron).toBe(null);
  });

  it('reports off when there is no cron line at all', () => {
    const yaml = TEMPLATE_YAML.replace(
      /  schedule:\n[^\n]*\n[^\n]*\n/,
      '',
    );
    const r = parseScheduleFromYaml(yaml);
    expect(r.preset).toBe('off');
  });

  it('reports unknown for a custom cron the user hand-edited', () => {
    const yaml = TEMPLATE_YAML.replace("'0 9 * * *'", "'15 3 * * *'");
    const r = parseScheduleFromYaml(yaml);
    expect(r.preset).toBe('unknown');
    expect(r.cron).toBe('15 3 * * *');
  });
});

describe('applyPresetToYaml', () => {
  it('switches daily → weekdays', () => {
    const out = applyPresetToYaml(TEMPLATE_YAML, 'weekdays');
    expect(out).toContain("- cron: '0 9 * * 1-5'");
    expect(out).not.toContain("- cron: '0 9 * * *'");
  });

  it('switches active cron to off (commented form)', () => {
    const out = applyPresetToYaml(TEMPLATE_YAML, 'off');
    expect(out).toMatch(/#\s*-\s+cron: '0 9 \* \* \*'\s+#\s*disabled/);
    // Active form gone:
    expect(out).not.toMatch(/^\s*-\s+cron: '0 9 \* \* \*'/m);
  });

  it('re-enables off → daily', () => {
    const out = applyPresetToYaml(DISABLED_YAML, 'daily');
    expect(out).toMatch(/^\s*-\s+cron: '0 9 \* \* \*'/m);
    expect(out).not.toMatch(/#\s*-\s+cron:/);
  });

  it('preserves indentation and the rest of the file verbatim', () => {
    const out = applyPresetToYaml(TEMPLATE_YAML, 'weekly');
    // Same number of lines (we replaced one, didn't add/remove)
    expect(out.split('\n').length).toBe(TEMPLATE_YAML.split('\n').length);
    expect(out).toContain('jobs:');
    expect(out).toContain('phase-bug-scout.yml@v1');
  });

  it('throws when the file has no `on:` block to recover into', () => {
    const broken = 'name: nope\njobs:\n  x:\n    runs-on: ubuntu-latest\n';
    expect(() => applyPresetToYaml(broken, 'daily')).toThrow(/no `on:`/);
  });

  // Reviewer-flagged: GitHub Actions allows multiple on.schedule.cron
  // entries. The previous single-regex approach left additional crons
  // active when the user picked "off" or any other preset, so the
  // workflow kept firing. The schedule block must be normalized as a
  // unit — exactly one cron line afterward.

  const TWO_CRONS_YAML = TEMPLATE_YAML.replace(
    "    - cron: '0 9 * * *'",
    "    - cron: '0 9 * * *'\n    - cron: '0 21 * * *'",
  );

  it('off: comments out the first cron AND removes additional crons', () => {
    const out = applyPresetToYaml(TWO_CRONS_YAML, 'off');
    // Only one cron-shaped line should remain, and it must be the
    // disabled-comment form. The hand-added second cron (0 21 * * *)
    // must be gone.
    const cronLines = out
      .split('\n')
      .filter((l) => /-\s+cron:/.test(l));
    expect(cronLines).toHaveLength(1);
    expect(cronLines[0]).toMatch(/^\s*#\s*-\s+cron: '0 9 \* \* \*'\s+#\s*disabled/);
    expect(out).not.toContain('0 21');
  });

  it('weekly: collapses two active crons to a single canonical line', () => {
    const out = applyPresetToYaml(TWO_CRONS_YAML, 'weekly');
    const cronLines = out
      .split('\n')
      .filter((l) => /-\s+cron:/.test(l));
    expect(cronLines).toHaveLength(1);
    expect(cronLines[0]).toMatch(/^\s*-\s+cron: '0 9 \* \* 1'$/);
    expect(out).not.toContain('0 21');
    expect(out).not.toContain("'0 9 * * *'"); // also gone
  });

  it('daily: collapses mixed (one active + one commented) to a single active line', () => {
    const mixed = TEMPLATE_YAML.replace(
      "    - cron: '0 9 * * *'",
      "    - cron: '0 9 * * *'\n    # - cron: '0 21 * * *'",
    );
    const out = applyPresetToYaml(mixed, 'daily');
    const cronLines = out
      .split('\n')
      .filter((l) => /-\s+cron:/.test(l));
    expect(cronLines).toHaveLength(1);
    expect(cronLines[0]).toMatch(/^\s*-\s+cron: '0 9 \* \* \*'$/);
    expect(out).not.toContain('0 21');
  });

  it('off: preserves user comments inside the schedule block while normalizing crons', () => {
    const yamlWithCommentBetweenCrons = TEMPLATE_YAML.replace(
      "    - cron: '0 9 * * *'",
      "    - cron: '0 9 * * *'\n    # we wanted a second tick because mornings are busy\n    - cron: '0 21 * * *'",
    );
    const out = applyPresetToYaml(yamlWithCommentBetweenCrons, 'off');
    // The user's explanatory comment lives on, even though both crons
    // are normalized to a single disabled line.
    expect(out).toContain('we wanted a second tick because mornings are busy');
    const cronLines = out
      .split('\n')
      .filter((l) => /-\s+cron:/.test(l));
    expect(cronLines).toHaveLength(1);
    expect(cronLines[0]).toMatch(/^\s*#\s*-\s+cron: '0 9 \* \* \*'\s+#\s*disabled/);
  });
});

describe('readBugScoutSchedule', () => {
  let octokit: { repos: { getContent: ReturnType<typeof vi.fn> } };

  beforeEach(() => {
    octokit = { repos: { getContent: vi.fn() } };
  });

  it('returns null preset when the workflow file is missing (404)', async () => {
    const err = Object.assign(new Error('Not Found'), { status: 404 });
    octokit.repos.getContent.mockRejectedValue(err);
    const r = await readBugScoutSchedule(octokit as never, 'o', 'r', 'main');
    expect(r.preset).toBe(null);
    expect(r.file_sha).toBe(null);
    expect(r.file_content).toBe(null);
  });

  it('parses the active cron when the file exists', async () => {
    octokit.repos.getContent.mockResolvedValue({
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(TEMPLATE_YAML, 'utf8').toString('base64'),
        sha: 'abc123',
      },
    });
    const r = await readBugScoutSchedule(octokit as never, 'o', 'r', 'main');
    expect(r.preset).toBe('daily');
    expect(r.cron).toBe('0 9 * * *');
    expect(r.file_sha).toBe('abc123');
    expect(r.file_content).toBe(TEMPLATE_YAML);
  });

  it('rethrows non-404 errors', async () => {
    const err = Object.assign(new Error('rate limit'), { status: 403 });
    octokit.repos.getContent.mockRejectedValue(err);
    await expect(
      readBugScoutSchedule(octokit as never, 'o', 'r', 'main'),
    ).rejects.toThrow(/rate limit/);
  });
});

describe('writeBugScoutSchedule', () => {
  let octokit: {
    repos: {
      getContent: ReturnType<typeof vi.fn>;
      createOrUpdateFileContents: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    octokit = {
      repos: {
        getContent: vi.fn(),
        createOrUpdateFileContents: vi.fn(),
      },
    };
    octokit.repos.getContent.mockResolvedValue({
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(TEMPLATE_YAML, 'utf8').toString('base64'),
        sha: 'abc123',
      },
    });
  });

  it('writes the new content + uses the file_sha for optimistic concurrency', async () => {
    await writeBugScoutSchedule(octokit as never, 'o', 'r', 'main', 'weekly');
    expect(octokit.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'o',
        repo: 'r',
        path: BUG_SCOUT_WORKFLOW_PATH,
        sha: 'abc123',
      }),
    );
    const call = octokit.repos.createOrUpdateFileContents.mock.calls[0][0];
    const decoded = Buffer.from(call.content, 'base64').toString('utf8');
    expect(decoded).toContain("- cron: '0 9 * * 1'");
  });

  it('is a no-op when preset matches current state', async () => {
    await writeBugScoutSchedule(octokit as never, 'o', 'r', 'main', 'daily');
    expect(octokit.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
  });

  it('throws when the workflow file is missing', async () => {
    const err = Object.assign(new Error('Not Found'), { status: 404 });
    octokit.repos.getContent.mockRejectedValue(err);
    await expect(
      writeBugScoutSchedule(octokit as never, 'o', 'r', 'main', 'daily'),
    ).rejects.toThrow(/Bug-scout workflow not found/);
  });
});
