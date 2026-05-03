import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { FeatureItem } from '@/lib/pipeline';

export function ActivityFeed({ items }: { items: FeatureItem[] }) {
  const sorted = [...items].sort((a, b) => a.age_seconds - b.age_seconds);
  if (sorted.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
        No recent activity.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {sorted.map((it) => (
        <Card key={`${it.repo}#${it.issue_number}`}>
          <CardContent className="flex items-center justify-between p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{it.state.replace('state:', '')}</Badge>
              <Link
                href={`/features/${it.issue_number}?repo=${encodeURIComponent(it.repo)}`}
                className="hover:underline"
              >
                {it.title}
              </Link>
              <span className="text-xs text-muted-foreground">
                {it.repo} #{it.issue_number}
              </span>
            </div>
            <span className="text-xs text-muted-foreground">
              {Math.floor(it.age_seconds / 60)}m ago
            </span>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
