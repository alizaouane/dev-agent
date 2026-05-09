import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { VerificationBadges } from '@/components/verification-badges';
import type { VerificationOutcome } from '@/lib/verification/types';
import type { StateLabel } from '@/lib/pipeline';

export type FeatureCardItem = {
  repo: string;
  issue_number: number;
  title: string;
  state: StateLabel;
  age_seconds: number;
  outcomes: VerificationOutcome[];
};

function ageLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function FeatureCard({ item, hideRepo = false }: { item: FeatureCardItem; hideRepo?: boolean }) {
  const featureHref = `/features/${item.issue_number}?repo=${encodeURIComponent(item.repo)}`;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <Badge variant="secondary">{item.state.replace('state:', '')}</Badge>
        {hideRepo ? null : <span className="text-xs text-muted-foreground">{item.repo}</span>}
        <span className="text-xs text-muted-foreground">{ageLabel(item.age_seconds)} ago</span>
      </div>
      <Link href={featureHref} className="font-medium hover:underline">
        {item.title}
      </Link>
      <VerificationBadges outcomes={item.outcomes} featureHref={featureHref} />
    </div>
  );
}
