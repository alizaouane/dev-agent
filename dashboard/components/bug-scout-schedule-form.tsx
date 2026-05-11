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
import { InstallScoutWorkflowPanel } from '@/components/install-scout-workflow-panel';

type Props = {
  repo: string;
  /** Current preset on disk. `unknown` if a human-edited cron string is in there; we still let the user overwrite to a preset. `null` means file isn't present. */
  current: SchedulePreset | 'unknown' | null;
  /** Raw cron when current is `unknown` — surfaced so user can see what's there. */
  currentCron: string | null;
};

export function BugScoutScheduleForm({ repo, current, currentCron }: Props) {
  // When the file isn't present at all, the form is read-only and points the
  // user at a one-click install. The bug-scout workflow ships in WIRE_UP_FILES
  // so a fresh wire-up always has it; this branch covers older wire-ups
  // that pre-date the bug-scout feature.
  if (current === null) {
    return (
      <InstallScoutWorkflowPanel
        repo={repo}
        workflow="bug-scout"
        title="Bug-scout workflow"
        description="This repo was wired up before bug-scout existed. Install it to start the daily LLM scan that files bug + vulnerability findings as issues."
      />
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
