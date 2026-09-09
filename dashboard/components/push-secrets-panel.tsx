'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { pushDashboardSecrets } from '@/lib/actions';

/**
 * Backfill the dashboard's Actions secrets into one already-wired repo.
 *
 * New wire-ups get these automatically. A repo wired before a secret existed
 * never did — and the gate that needs it has been passing without checking
 * anything ever since, which is the failure this whole panel exists to end.
 *
 * The values live only on the dashboard and are sealed-box encrypted before
 * transmission; nothing here ever renders one. Pushing Actions secrets needs
 * admin permission on the repo, so a user with write access will see a
 * per-secret failure rather than a silent no-op.
 */
export function PushSecretsPanel({ repo }: { repo: string }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const onClick = () => {
    setResult(null);
    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.append('repo', repo);
        const r = await pushDashboardSecrets(fd);
        setResult(
          'error' in r ? { ok: false, text: r.error } : { ok: true, text: r.message },
        );
      } catch (err) {
        setResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
      }
    });
  };

  return (
    <div className="rounded-md border border-border bg-card p-5 text-sm">
      <p className="font-medium">Repository secrets</p>
      <p className="mt-1 text-muted-foreground">
        Pushes the secrets configured on the dashboard into this repo, so the
        same value does not have to be pasted into each one by hand. Safe to
        run again at any time; it overwrites rather than duplicating.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <Button type="button" onClick={onClick} disabled={pending} size="sm">
          {pending ? 'Pushing…' : 'Push dashboard secrets'}
        </Button>
        <span className="text-xs text-muted-foreground">
          Requires admin permission on the repo.
        </span>
      </div>
      {result ? (
        <p
          className={
            result.ok ? 'mt-2 text-xs text-muted-foreground' : 'mt-2 text-xs text-destructive'
          }
        >
          {result.text}
        </p>
      ) : null}
    </div>
  );
}
