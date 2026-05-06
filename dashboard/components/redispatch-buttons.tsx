'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { redispatchPhase } from '@/lib/actions';

type Props = {
  repo: string;
  issue: number;
  /**
   * Hide the re-dispatch buttons while a run is already in flight —
   * dispatching a second run while one is running creates parallel
   * agent invocations that race on the same branch and confuse
   * telemetry.
   */
  hasActiveRun: boolean;
};

const PHASES = ['implement', 'staging-deploy', 'promote-to-prod', 'rollback'] as const;
type Phase = (typeof PHASES)[number];

/**
 * Re-dispatch controls on the feature page. Replaces dropping into
 * `gh workflow run dev-agent.yml -f phase=... -f issue_number=... -f invocation_mode=...`
 * for the common "retry implement" / "kick off staging-deploy" /
 * "rollback" flows. Stub mode is the cheap test path — it cycles
 * through workflow validation without invoking the agent, so a click
 * costs nothing.
 */
export function RedispatchButtons({ repo, issue, hasActiveRun }: Props) {
  const [phase, setPhase] = useState<Phase>('implement');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dispatchedAt, setDispatchedAt] = useState<number | null>(null);

  const dispatch = (mode: 'live' | 'stub') => {
    if (!confirm(`Re-dispatch ${phase} (${mode}) on issue #${issue}?`)) return;
    setError(null);
    setDispatchedAt(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.append('repo', repo);
      fd.append('issue', String(issue));
      fd.append('phase', phase);
      fd.append('invocation_mode', mode);
      const result = await redispatchPhase(fd);
      if (result && 'error' in result) {
        setError(result.error);
      } else {
        setDispatchedAt(Date.now());
      }
    });
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {/* Real <label htmlFor> association so screen readers
            announce the select with its purpose. The visual
            placement is unchanged. */}
        <label htmlFor="redispatch-phase" className="text-muted-foreground">
          Re-dispatch:
        </label>
        <select
          id="redispatch-phase"
          className="rounded-md border border-input bg-background px-2 py-1 text-xs"
          value={phase}
          onChange={(e) => setPhase(e.target.value as Phase)}
          disabled={pending}
        >
          {PHASES.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <Button
          size="sm"
          variant="default"
          onClick={() => dispatch('live')}
          disabled={pending || hasActiveRun}
          title={hasActiveRun ? 'A run is already in flight on this issue.' : ''}
        >
          {pending ? 'Sending…' : 'Live'}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => dispatch('stub')}
          disabled={pending || hasActiveRun}
          title={hasActiveRun ? 'A run is already in flight on this issue.' : 'Free smoke test — workflow runs without invoking the agent.'}
        >
          Stub
        </Button>
      </div>
      {error ? (
        <p className="text-xs text-destructive break-words">{error}</p>
      ) : null}
      {dispatchedAt ? (
        <p className="text-xs text-muted-foreground">
          Dispatched. The new run should appear in &ldquo;Running now&rdquo; within ~15s — refresh the page if not.
        </p>
      ) : null}
    </div>
  );
}
