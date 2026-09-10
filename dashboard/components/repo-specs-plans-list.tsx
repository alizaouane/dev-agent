'use client';

import { useMemo, useState } from 'react';

/**
 * Browser for the spec and plan markdown committed to the default branch.
 *
 * Renders newest-first and shows a handful by default. Listing every file was
 * the original behaviour and it does not survive a real repo: whatsapp-console
 * carries 259 specs and 234 plans, and several hundred unordered rows answer
 * no question anyone has. A spec written in March is history, not a decision
 * waiting to be made.
 *
 * **What this deliberately does not claim.** There is no done/in-progress
 * filter, because a file has no status — status lives on the issue that
 * references it, and most of these files have no issue at all. A control
 * labelled "in progress" driven by a filename would be a guess wearing a
 * filter's clothing. For what is actually in flight, the pipeline view is the
 * honest answer, and the header says so.
 */
export function RepoSpecsPlansList({
  repoHtmlUrl,
  defaultBranch,
  specs,
  plans,
}: {
  repoHtmlUrl: string;
  defaultBranch: string;
  specs: string[];
  plans: string[];
}) {
  if (specs.length === 0 && plans.length === 0) {
    return (
      <div className="rounded-md border border-border bg-card p-5 text-sm text-muted-foreground">
        No spec or plan files committed under{' '}
        <code>docs/superpowers/specs/</code>, <code>docs/specs/</code>,{' '}
        <code>docs/superpowers/plans/</code>, or <code>docs/plans/</code> on{' '}
        <code>{defaultBranch}</code>.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Every spec and plan on <code>{defaultBranch}</code>, newest first. These are
        files, not work items — for what is in flight, see{' '}
        <a className="underline" href="/pipeline">
          Pipeline
        </a>
        .
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <FileList
          title="Specs"
          emptyText="No spec files."
          files={specs}
          repoHtmlUrl={repoHtmlUrl}
          defaultBranch={defaultBranch}
        />
        <FileList
          title="Plans"
          emptyText="No plan files."
          files={plans}
          repoHtmlUrl={repoHtmlUrl}
          defaultBranch={defaultBranch}
        />
      </div>
    </div>
  );
}

/** How many rows to show before the reader asks for more. */
const PAGE = 8;

/**
 * Sort newest-first by the `YYYY-MM-DD` prefix these files are named with.
 *
 * Anything unprefixed sorts after the dated files, reverse-alphabetically, so
 * the order stays stable rather than arbitrary.
 *
 * @param files - Repo-relative paths.
 * @returns The same paths, newest first.
 */
export function newestFirst(files: string[]): string[] {
  const dateOf = (p: string) => p.split('/').pop()?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? '';
  return [...files].sort((a, b) => {
    const [da, db] = [dateOf(a), dateOf(b)];
    if (da && db && da !== db) return db.localeCompare(da);
    if (da && !db) return -1;
    if (!da && db) return 1;
    return b.localeCompare(a);
  });
}

/**
 * One column of files, filterable by name and collapsed to the newest few.
 *
 * @param title - Column heading. The count is rendered from what is actually
 *   shown, so it never disagrees with the list beneath it.
 * @param emptyText - Shown when the repo has none of this kind.
 * @param files - Repo-relative paths.
 * @param repoHtmlUrl - Base URL for the blob links.
 * @param defaultBranch - Ref the files are read from.
 */
function FileList({
  title,
  emptyText,
  files,
  repoHtmlUrl,
  defaultBranch,
}: {
  title: string;
  emptyText: string;
  files: string[];
  repoHtmlUrl: string;
  defaultBranch: string;
}) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);

  const sorted = useMemo(() => newestFirst(files), [files]);
  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q === '' ? sorted : sorted.filter((p) => p.toLowerCase().includes(q));
  }, [sorted, query]);
  // Searching is a request to see what matched, so it opens the list rather
  // than hiding results behind "show older".
  const searching = query.trim() !== '';
  const shown = expanded || searching ? matched : matched.slice(0, PAGE);
  const hidden = matched.length - shown.length;

  return (
    <div className="rounded-md border border-border bg-card p-4">
      <h3 className="mb-2 text-sm font-semibold">
        {title}{' '}
        <span className="font-normal text-muted-foreground">
          ({matched.length}
          {searching && matched.length !== files.length ? ` of ${files.length}` : ''})
        </span>
      </h3>

      {files.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <>
          {files.length > PAGE ? (
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Filter ${title.toLowerCase()} by name…`}
              aria-label={`Filter ${title.toLowerCase()} by name`}
              className="mb-2 w-full rounded border border-border bg-background px-2 py-1 text-sm"
            />
          ) : null}

          {matched.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing matches that.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {shown.map((path) => {
                const parts = path.split('/');
                const filename = parts.pop() ?? path;
                const dir = parts.join('/');
                return (
                  <li key={path} className="flex items-start justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <a
                        href={`${repoHtmlUrl}/blob/${defaultBranch}/${path}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block truncate font-medium hover:underline"
                      >
                        {filename}
                      </a>
                      <span className="block truncate text-xs text-muted-foreground">{dir}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {hidden > 0 ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-2 text-xs text-muted-foreground underline"
            >
              Show {hidden} older
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
