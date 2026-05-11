'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { installScoutWorkflow } from '@/lib/actions';
import type { ScoutWorkflowKey } from '@/lib/wire-up-template';

type Props = {
  repo: string;
  workflow: ScoutWorkflowKey;
  /** Short noun shown in the heading ("Bug-scout workflow", "PM scan", "Cleanup scan"). */
  title: string;
  /** One-liner explaining what this scout does, shown beneath the title. */
  description: string;
};

/**
 * Amber "not installed" panel shared by the three scout-section components on
 * /repos/[name]. Posts to `installScoutWorkflow` to drop the missing workflow
 * file onto the consumer's default branch in one click — replaces the older
 * "copy this file from examples/web-app-template…" instructions.
 */
export function InstallScoutWorkflowPanel({
  repo,
  workflow,
  title,
  description,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClick = () => {
    setError(null);
    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.append('repo', repo);
        fd.append('workflow', workflow);
        const result = await installScoutWorkflow(fd);
        if (result && 'error' in result) setError(result.error);
        // Success path: revalidatePath re-renders the page, the parent
        // re-probes the workflow file, and this panel disappears.
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm">
      <p className="font-medium">{title} isn&apos;t installed.</p>
      <p className="mt-1 text-muted-foreground">{description}</p>
      <div className="mt-3 flex items-center gap-3">
        <Button type="button" onClick={onClick} disabled={pending} size="sm">
          {pending ? 'Installing…' : `Install ${title.toLowerCase()}`}
        </Button>
        <span className="text-xs text-muted-foreground">
          Commits the workflow file directly to your default branch. No PR.
        </span>
      </div>
      {error ? (
        <p className="mt-2 text-xs text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
