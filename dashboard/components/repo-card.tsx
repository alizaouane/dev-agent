import Link from 'next/link';

function ageLabel(seconds: number | null): string {
  if (seconds === null) return 'never';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function RepoCard({
  repo,
  in_flight_count,
  proposals_count,
  last_shipped_age_seconds,
  cost_7d_usd,
}: {
  repo: string;
  in_flight_count: number;
  proposals_count: number;
  last_shipped_age_seconds: number | null;
  cost_7d_usd: number;
}) {
  const href = `/repos/${encodeURIComponent(repo)}`;
  return (
    <Link
      href={href}
      className="flex flex-col gap-1 rounded-md border border-border bg-card p-4 hover:bg-accent/30"
    >
      <span className="font-medium">{repo}</span>
      <span className="text-xs text-muted-foreground">
        {in_flight_count} in flight · {proposals_count} proposal{proposals_count === 1 ? '' : 's'}
      </span>
      <span className="text-xs text-muted-foreground">
        last shipped {ageLabel(last_shipped_age_seconds)} · ${cost_7d_usd.toFixed(2)} (7d)
      </span>
    </Link>
  );
}
