'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { dispatchFromSpec } from '@/lib/actions';

/**
 * Per-repo panel that lets the user start implementation from a spec +
 * plan that already live on the default branch — without going through
 * the `/develop` flow. Used for specs authored before `/develop`
 * existed, or any other path that left spec+plan committed without a
 * matching `state:spec-ready` issue.
 *
 * On submit, calls `dispatchFromSpec` which creates the missing issue
 * and immediately dispatches `phase=implement`. The server action's
 * `{ error }` contract is honored the same way as
 * `FeatureApproveButton`.
 */
export function StartFromSpecPanel({
  repo,
  specs,
  plans,
}: {
  repo: string;
  specs: string[];
  plans: string[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [specPath, setSpecPath] = useState(specs[0] ?? '');
  const [planPath, setPlanPath] = useState(plans[0] ?? '');
  const [title, setTitle] = useState('');

  const noSpecsOrPlans = specs.length === 0 || plans.length === 0;

  return (
    <div className="rounded-md border border-border bg-card p-5">
      <h3 className="mb-1 text-base font-semibold">
        Start implementation from an existing spec
      </h3>
      <p className="mb-4 max-w-2xl text-sm text-muted-foreground">
        Pick a spec and plan already committed to the default branch. Filing an
        issue and dispatching the implement workflow happen in one click — no{' '}
        <code>/develop</code> session required. Use this for specs authored
        before <code>/develop</code> existed, or any other case where spec +
        plan are already in place.
      </p>

      {noSpecsOrPlans ? (
        <p className="text-sm text-muted-foreground">
          No spec or plan files found under{' '}
          <code>docs/superpowers/specs/</code>, <code>docs/specs/</code>,{' '}
          <code>docs/superpowers/plans/</code>, or <code>docs/plans/</code> on
          the default branch. Commit spec + plan first, then come back.
        </p>
      ) : (
        <form
          action={(formData) => {
            setError(null);
            startTransition(async () => {
              try {
                const result = await dispatchFromSpec(formData);
                if (result && 'error' in result) {
                  setError(result.error);
                }
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                if (msg.includes('NEXT_REDIRECT')) throw e;
                setError(msg);
              }
            });
          }}
          className="flex flex-col gap-3"
        >
          <input type="hidden" name="repo" value={repo} />

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Spec</span>
            <select
              name="spec_path"
              value={specPath}
              onChange={(e) => setSpecPath(e.target.value)}
              required
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            >
              {specs.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Plan</span>
            <select
              name="plan_path"
              value={planPath}
              onChange={(e) => setPlanPath(e.target.value)}
              required
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            >
              {plans.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Title</span>
            <input
              type="text"
              name="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. CSV export on the reports page"
              required
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            />
            <span className="text-xs text-muted-foreground">
              Shows up as the GitHub issue title.
            </span>
          </label>

          <Button type="submit" disabled={pending} className="self-start">
            {pending ? 'Starting…' : 'File issue and start implementation'}
          </Button>

          {error ? (
            <span className="max-w-md text-xs text-destructive">{error}</span>
          ) : null}
        </form>
      )}
    </div>
  );
}
