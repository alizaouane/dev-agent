/**
 * Read-only list of spec + plan markdown files committed to the
 * default branch. Sits above StartFromSpecPanel on the per-repo page so
 * the user can browse what's already there before deciding what to
 * dispatch.
 *
 * Files come pre-fetched from listSpecAndPlanFiles. Each row links to
 * the file's blob view on GitHub.
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
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <FileList
        title={`Specs (${specs.length})`}
        emptyText="No spec files."
        files={specs}
        repoHtmlUrl={repoHtmlUrl}
        defaultBranch={defaultBranch}
      />
      <FileList
        title={`Plans (${plans.length})`}
        emptyText="No plan files."
        files={plans}
        repoHtmlUrl={repoHtmlUrl}
        defaultBranch={defaultBranch}
      />
    </div>
  );
}

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
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {files.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {files.map((path) => {
            const filename = path.split('/').pop() ?? path;
            const dir = path.slice(0, path.length - filename.length - 1);
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
    </div>
  );
}
