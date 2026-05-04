import type { Octokit } from '@octokit/rest';

/**
 * Read + write the bug-scout cron schedule on a wired-up consumer repo.
 *
 * The schedule lives inline in `.github/workflows/dev-agent-bug-scout.yml`
 * because GitHub Actions does not allow dynamic crons — `on.schedule.cron`
 * must be a literal string. Changing the schedule means rewriting that
 * file and committing back to the default branch.
 *
 * We expose a small, fixed set of presets rather than letting the user
 * type a raw cron — most users don't need the flexibility, and an invalid
 * cron silently disables the workflow (GitHub doesn't validate crons at
 * push time).
 */

export const SCHEDULE_PRESETS = ['daily', 'weekdays', 'weekly', 'off'] as const;
export type SchedulePreset = (typeof SCHEDULE_PRESETS)[number];

const PRESET_TO_CRON: Record<Exclude<SchedulePreset, 'off'>, string> = {
  daily: '0 9 * * *',
  weekdays: '0 9 * * 1-5',
  weekly: '0 9 * * 1',
};

export const PRESET_LABELS: Record<SchedulePreset, string> = {
  daily: 'Daily 09:00 UTC',
  weekdays: 'Weekdays 09:00 UTC',
  weekly: 'Weekly Mondays 09:00 UTC',
  off: 'Off (manual only)',
};

export const PRESET_COSTS: Record<SchedulePreset, string> = {
  daily: '~$9–30 / month',
  weekdays: '~$7–20 / month',
  weekly: '~$1–4 / month',
  off: 'No scheduled cost',
};

export const BUG_SCOUT_WORKFLOW_PATH = '.github/workflows/dev-agent-bug-scout.yml';

export type BugScoutSchedule = {
  /** Currently active preset, derived from the cron string. `null` if the workflow file isn't present at all. */
  preset: SchedulePreset | 'unknown' | null;
  /** Raw cron string when active. `null` for `off` or `unknown`. */
  cron: string | null;
  /** Git blob SHA needed for a subsequent update. `null` if the file doesn't exist. */
  file_sha: string | null;
  /** Full workflow file content (for transparency in tests + future raw-edit support). `null` if absent. */
  file_content: string | null;
};

export function cronToPreset(cron: string): SchedulePreset | 'unknown' {
  if (cron === PRESET_TO_CRON.daily) return 'daily';
  if (cron === PRESET_TO_CRON.weekdays) return 'weekdays';
  if (cron === PRESET_TO_CRON.weekly) return 'weekly';
  return 'unknown';
}

/**
 * Parse the bug-scout workflow YAML and report the active schedule. We
 * use a regex rather than a YAML parser because we want to preserve
 * comments and exact whitespace on round-trip — js-yaml drops both.
 *
 * Recognized line shapes:
 *   - `    - cron: '0 9 * * *'`         → active
 *   - `    # - cron: '0 9 * * *'`       → off (commented-out form we write)
 *   - missing entirely                   → off (no schedule key at all)
 */
export function parseScheduleFromYaml(yaml: string): {
  preset: SchedulePreset | 'unknown';
  cron: string | null;
} {
  const activeRe = /^\s*-\s+cron:\s*['"]([^'"]+)['"]/m;
  const m = yaml.match(activeRe);
  if (m) {
    const cron = m[1].trim();
    return { preset: cronToPreset(cron), cron };
  }
  return { preset: 'off', cron: null };
}

/**
 * Apply a preset to a workflow YAML string. Returns the new YAML.
 *
 * **Strategy.** Walk the file line-by-line. When we hit `schedule:`, we
 * treat its indented body as a unit and rewrite it: the FIRST cron
 * entry (active or commented-out) becomes the canonical line for the
 * chosen preset, and every additional cron entry inside the block is
 * dropped. This matters because GitHub Actions allows multiple
 * `on.schedule.cron` entries — a hand-edited file with two crons
 * wasn't fully normalized by the previous single-regex approach, so
 * "Off" left the second cron firing. Comments and blank lines inside
 * the schedule block are preserved.
 *
 * Recovery path: if there's no `schedule:` key at all (someone deleted
 * it), inject a fresh schedule block after the `on:` line. Throws if
 * `on:` is also missing — refusing to mutate a file we don't recognize.
 */
export function applyPresetToYaml(yaml: string, preset: SchedulePreset): string {
  const lines = yaml.split('\n');
  const out: string[] = [];

  let inSchedule = false;
  let scheduleIndent = 0;
  let cronEmitted = false;
  let foundScheduleKey = false;

  const isCronLine = (line: string): boolean =>
    /^\s*(?:#\s*)?-\s+cron:\s*['"][^'"]+['"]/.test(line);

  const indentOf = (line: string): number => {
    const m = line.match(/^(\s*)/);
    return m ? m[1].length : 0;
  };

  const canonicalCronLine = (indent: number): string => {
    const pad = ' '.repeat(indent);
    return preset === 'off'
      ? `${pad}# - cron: '0 9 * * *'  # disabled — only workflow_dispatch fires this workflow`
      : `${pad}- cron: '${PRESET_TO_CRON[preset]}'`;
  };

  for (const line of lines) {
    // Open a schedule block.
    if (!inSchedule && /^\s*schedule:\s*$/.test(line)) {
      foundScheduleKey = true;
      inSchedule = true;
      scheduleIndent = indentOf(line);
      cronEmitted = false;
      out.push(line);
      continue;
    }

    if (inSchedule) {
      // Determine if this line is still inside the schedule block. The
      // block contains anything indented MORE than `schedule:` itself,
      // plus blank lines (which YAML treats as part of the surrounding
      // block).
      const isBlank = line.trim() === '';
      const stillInside = isBlank || indentOf(line) > scheduleIndent;

      if (!stillInside) {
        // We've left the schedule block. If we never wrote a canonical
        // cron (block was empty or only had comments), emit one now so
        // the file remains valid. Then fall through to handle the
        // boundary line normally.
        if (!cronEmitted) {
          out.push(canonicalCronLine(scheduleIndent + 2));
          cronEmitted = true;
        }
        inSchedule = false;
        out.push(line);
        continue;
      }

      // Inside the schedule block.
      if (isCronLine(line)) {
        if (!cronEmitted) {
          out.push(canonicalCronLine(indentOf(line)));
          cronEmitted = true;
        }
        // Subsequent cron entries — drop them entirely.
        continue;
      }

      // Comment / blank / nested non-cron content — preserve.
      out.push(line);
      continue;
    }

    // Outside any schedule block — pass through.
    out.push(line);
  }

  // If the file ended while we were still inside the schedule block
  // and never emitted a cron, emit one now.
  if (inSchedule && !cronEmitted) {
    out.push(canonicalCronLine(scheduleIndent + 2));
  }

  if (foundScheduleKey) {
    return out.join('\n');
  }

  // Recovery path: no `schedule:` key found anywhere. Inject a fresh
  // block after the `on:` line.
  const onLineRe = /^on:\s*$/m;
  if (!onLineRe.test(yaml)) {
    throw new Error('Workflow file has no `on:` block — refusing to mutate.');
  }
  return yaml.replace(
    onLineRe,
    `on:\n  schedule:\n${canonicalCronLine(4)}`,
  );
}

/**
 * Read the bug-scout workflow file from `default_branch` and report the
 * active schedule. Returns `{preset: null}` if the workflow file isn't
 * present (the user hasn't enabled bug-scout, or their wire-up is older
 * than the bug-scout feature).
 */
export async function readBugScoutSchedule(
  octokit: Octokit,
  owner: string,
  repo: string,
  default_branch: string,
): Promise<BugScoutSchedule> {
  let resp: Awaited<ReturnType<typeof octokit.repos.getContent>>;
  try {
    resp = await octokit.repos.getContent({
      owner,
      repo,
      path: BUG_SCOUT_WORKFLOW_PATH,
      ref: default_branch,
    });
  } catch (err) {
    if ((err as { status?: number }).status === 404) {
      return { preset: null, cron: null, file_sha: null, file_content: null };
    }
    throw err;
  }
  const data = resp.data as { content?: string; encoding?: string; sha?: string; type?: string };
  if (data.type !== 'file' || !data.content || data.encoding !== 'base64') {
    return { preset: null, cron: null, file_sha: null, file_content: null };
  }
  const content = Buffer.from(data.content, 'base64').toString('utf8');
  const { preset, cron } = parseScheduleFromYaml(content);
  return { preset, cron, file_sha: data.sha ?? null, file_content: content };
}

/**
 * Write a new schedule preset to the bug-scout workflow file on
 * `default_branch`. Throws if the workflow file doesn't exist (caller
 * should check `readBugScoutSchedule` first and surface a "wire up
 * bug-scout first" message).
 */
export async function writeBugScoutSchedule(
  octokit: Octokit,
  owner: string,
  repo: string,
  default_branch: string,
  preset: SchedulePreset,
): Promise<void> {
  const current = await readBugScoutSchedule(octokit, owner, repo, default_branch);
  if (current.file_sha === null || current.file_content === null) {
    throw new Error(
      `Bug-scout workflow not found at ${BUG_SCOUT_WORKFLOW_PATH} on ${owner}/${repo}@${default_branch}`,
    );
  }
  if (current.preset === preset) {
    // No-op — nothing to write.
    return;
  }
  const newContent = applyPresetToYaml(current.file_content, preset);
  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: BUG_SCOUT_WORKFLOW_PATH,
    message: `chore(dev-agent): set bug-scout schedule to ${preset}`,
    content: Buffer.from(newContent, 'utf8').toString('base64'),
    sha: current.file_sha,
  });
}
