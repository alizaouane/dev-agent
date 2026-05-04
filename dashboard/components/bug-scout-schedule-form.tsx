'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  PRESET_LABELS,
  PRESET_COSTS,
  SCHEDULE_PRESETS,
  type SchedulePreset,
} from '@/lib/bug-scout-schedule';
import { setBugScoutSchedule } from '@/lib/actions';

type Props = {
  repo: string;
  /** Current preset on disk. `unknown` if a human-edited cron string is in there; we still let the user overwrite to a preset. `null` means file isn't present. */
  current: SchedulePreset | 'unknown' | null;
  /** Raw cron when current is `unknown` — surfaced so user can see what's there. */
  currentCron: string | null;
};

export function BugScoutScheduleForm({ repo, current, currentCron }: Props) {
  // When the file isn't present at all, the form is read-only and points the
  // user at the wire-up flow. The bug-scout workflow ships in WIRE_UP_FILES
  // so a fresh wire-up always has it; this branch covers older wire-ups
  // that pre-date the bug-scout feature.
  if (current === null) {
    return (
      <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm">
        <p className="font-medium">Bug-scout workflow isn&apos;t installed.</p>
        <p className="mt-1 text-muted-foreground">
          This repo was wired up before bug-scout existed. Re-running wire-up
          would add it, but that requires deleting <code>.dev-agent.yml</code>{' '}
          first. Open an issue if you want a one-click upgrade — for now,
          copy the workflow file from the dev-agent repo&apos;s{' '}
          <code>examples/web-app-template/.github/workflows/dev-agent-bug-scout.yml</code>{' '}
          and commit it to <code>.github/workflows/</code>.
        </p>
      </div>
    );
  }

  const initial: SchedulePreset =
    current === 'unknown' ? 'off' : current;
  const [preset, setPreset] = useState<SchedulePreset>(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const dirty = preset !== current;

  const onSave = () => {
    setError(null);
    setSavedAt(null);
    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.append('repo', repo);
        fd.append('preset', preset);
        await setBugScoutSchedule(fd);
        setSavedAt(Date.now());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <div className="flex max-w-xl flex-col gap-3">
      {current === 'unknown' && currentCron ? (
        <p className="text-xs text-muted-foreground">
          A custom cron is currently in the workflow file:{' '}
          <code>{currentCron}</code>. Saving below will overwrite it.
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor="bug-scout-preset">Schedule</Label>
        <Select
          name="preset"
          value={preset}
          onValueChange={(v) => setPreset(v as SchedulePreset)}
        >
          <SelectTrigger id="bug-scout-preset">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCHEDULE_PRESETS.map((p) => (
              <SelectItem key={p} value={p}>
                {PRESET_LABELS[p]} — {PRESET_COSTS[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-3">
        <Button type="button" onClick={onSave} disabled={!dirty || pending} size="sm">
          {pending ? 'Saving…' : 'Save schedule'}
        </Button>
        {savedAt ? (
          <span className="text-xs text-muted-foreground">
            Saved. Commits to default branch — the new cron takes effect on the
            next scheduled tick.
          </span>
        ) : null}
        {error ? (
          <span className="text-xs text-destructive">{error}</span>
        ) : null}
      </div>
    </div>
  );
}
