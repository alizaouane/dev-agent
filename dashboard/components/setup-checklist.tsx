export type SetupSteps = {
  wired: boolean;
  pm_md_present: boolean;
  scout_configured: boolean;
  first_proposal: boolean;
  first_feature_shipped: boolean;
};

const LABELS: Array<{ key: keyof SetupSteps; label: string }> = [
  { key: 'wired', label: 'Repo wired up' },
  { key: 'pm_md_present', label: 'pm.md present' },
  { key: 'scout_configured', label: 'Scout sources configured' },
  { key: 'first_proposal', label: 'First proposal generated' },
  { key: 'first_feature_shipped', label: 'First feature shipped' },
];

export function SetupChecklist({ repoName, steps }: { repoName: string; steps: SetupSteps }) {
  const allDone = LABELS.every(({ key }) => steps[key]);
  if (allDone) return null;
  return (
    <div className="rounded-md border border-border bg-card p-5">
      <h3 className="mb-2 text-base font-semibold">Set up checklist for {repoName}</h3>
      <ul className="flex flex-col gap-1 text-sm">
        {LABELS.map(({ key, label }) => (
          <li key={key} className={steps[key] ? 'text-muted-foreground' : ''}>
            {steps[key] ? '✓' : '☐'} {label}
          </li>
        ))}
      </ul>
    </div>
  );
}
