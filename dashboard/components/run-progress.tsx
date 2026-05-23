'use client';

// no glossary terms in user-visible strings

import { useEffect, useState } from 'react';

type StepDetail = {
  number: number;
  name: string;
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | skipped | null
};

type JobDetail = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string;
  steps: StepDetail[];
};

type ProgressResponse = {
  run_id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  jobs: JobDetail[];
};

type Props = {
  runId: number;
  repo: string;
  /**
   * When the active-runs panel knows the run finished (status flipped
   * to completed at the workflow level), it stops mounting the
   * progress fetcher. While mounted, we poll on a slow tick.
   */
  pollMs?: number;
};

/**
 * Per-run live step progress. Polls /api/runs/[id]/progress on a
 * fixed cadence and renders a checklist of steps. The "currently
 * running" step gets a spinner; completed steps get a success/failure
 * dot. Stops polling when the underlying run leaves the in_progress /
 * queued / waiting bucket — a parent re-render will then unmount us.
 *
 * Default cadence: 8s. GitHub's API rate limit (5000/h authenticated)
 * comfortably absorbs even a busy operator with the feature page
 * open across multiple in-flight runs.
 */
export function RunProgress({ runId, repo, pollMs = 8000 }: Props) {
  const [data, setData] = useState<ProgressResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const url = `/api/runs/${runId}/progress?repo=${encodeURIComponent(repo)}`;
        const resp = await fetch(url, { cache: 'no-store' });
        if (!resp.ok) {
          const txt = `HTTP ${resp.status}`;
          if (resp.status === 401 || resp.status === 404) {
            // Permanent stop conditions: clear any cached progress
            // so the operator doesn't keep staring at the last good
            // checklist (which would otherwise persist because the
            // render preferred `data` over `error`). Showing the
            // error string makes the dropped state explicit.
            if (!cancelled) {
              setData(null);
              setError(txt);
            }
            return;
          }
          // Transient — keep polling; show the error inline.
          if (!cancelled) setError(txt);
        } else {
          const json = (await resp.json()) as ProgressResponse;
          if (!cancelled) {
            setData(json);
            setError(null);
          }
          // Stop polling once the run completes; the parent feature
          // page revalidates on its 15s cycle and will hide the panel.
          if (json.status === 'completed') return;
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
      if (!cancelled) {
        timer = setTimeout(tick, pollMs);
      }
    };

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, repo, pollMs]);

  if (!data) {
    if (error) {
      return <p className="text-xs text-muted-foreground">progress unavailable: {error}</p>;
    }
    return <p className="text-xs text-muted-foreground">loading progress…</p>;
  }

  // Most runs have one primary job. Multiple jobs (the wrapper's
  // gated phases) — show only the one that's actually running, since
  // skipped jobs add no signal.
  const interesting = data.jobs.filter((j) => j.status !== 'completed' || j.conclusion !== 'skipped');
  const visible = interesting.length > 0 ? interesting : data.jobs;

  return (
    <div className="flex flex-col gap-2">
      {visible.map((job) => (
        <JobChecklist key={job.id} job={job} />
      ))}
    </div>
  );
}

function JobChecklist({ job }: { job: JobDetail }) {
  const completedSteps = job.steps.filter((s) => s.status === 'completed').length;
  const totalSteps = job.steps.length;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
        <span className="font-mono">{job.name}</span>
        <span>
          {completedSteps}/{totalSteps} steps
        </span>
      </div>
      <ol className="flex flex-col gap-0.5">
        {job.steps.map((s) => (
          <li
            key={`${job.id}-${s.number}`}
            className="flex items-center gap-2 text-xs leading-snug"
          >
            <StepDot status={s.status} conclusion={s.conclusion} />
            <span
              className={
                s.status === 'in_progress'
                  ? 'font-medium'
                  : s.status === 'queued'
                    ? 'text-muted-foreground'
                    : ''
              }
            >
              {s.name}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function StepDot({
  status,
  conclusion,
}: {
  status: string;
  conclusion: string | null;
}) {
  if (status === 'in_progress') {
    return (
      <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-500 opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
      </span>
    );
  }
  if (status === 'queued') {
    return <span aria-hidden className="inline-flex h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40" />;
  }
  // completed
  let cls = 'bg-muted-foreground/40';
  if (conclusion === 'success') cls = 'bg-emerald-500';
  else if (conclusion === 'failure' || conclusion === 'timed_out') cls = 'bg-destructive';
  else if (conclusion === 'skipped' || conclusion === 'cancelled') cls = 'bg-muted-foreground/60';
  return <span aria-hidden className={`inline-flex h-2 w-2 shrink-0 rounded-full ${cls}`} />;
}
