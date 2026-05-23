import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { renderStateBadgeContent } from '@/lib/state-label';
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
  const s = Math.max(0, seconds); // clamp negative
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function FeatureCard({ item, hideRepo = false }: { item: FeatureCardItem; hideRepo?: boolean }) {
  const featureHref = `/features/${item.issue_number}?repo=${encodeURIComponent(item.repo)}`;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <Badge variant="secondary">{renderStateBadgeContent(item.state)}</Badge>
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
