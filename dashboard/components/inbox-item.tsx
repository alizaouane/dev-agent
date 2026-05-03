import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { FeatureItem } from '@/lib/pipeline';
import { approveGate, abandonFeature } from '@/lib/actions';

function ageLabel(seconds: number): string {
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function actionLabel(state: FeatureItem['state']): string {
  if (state === 'state:spec-ready') return 'Approve';
  if (state === 'state:pr-review') return 'Approve (after merge)';
  if (state === 'state:ready-to-promote') return 'Promote';
  return '';
}

export function InboxItem({ item }: { item: FeatureItem }) {
  const isPromote = item.state === 'state:ready-to-promote';
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <Link
            href={`/features/${item.issue_number}?repo=${encodeURIComponent(item.repo)}`}
            className="font-medium hover:underline"
          >
            {item.title}
          </Link>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary">{item.state.replace('state:', '')}</Badge>
            <span>{item.repo}</span>
            <span>#{item.issue_number}</span>
            <span>{ageLabel(item.age_seconds)} old</span>
          </div>
          {item.blockers.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {item.blockers.map((b) => (
                <Badge key={b} variant="destructive">
                  {b}
                </Badge>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-shrink-0 gap-2">
          {actionLabel(item.state) && (
            <form action={approveGate}>
              <input type="hidden" name="repo" value={item.repo} />
              <input type="hidden" name="issue" value={item.issue_number} />
              <input type="hidden" name="promote" value={isPromote ? '1' : '0'} />
              <Button type="submit" size="sm">
                {actionLabel(item.state)}
              </Button>
            </form>
          )}
          <form action={abandonFeature}>
            <input type="hidden" name="repo" value={item.repo} />
            <input type="hidden" name="issue" value={item.issue_number} />
            <Button type="submit" size="sm" variant="ghost">
              Abandon
            </Button>
          </form>
        </div>
      </CardContent>
    </Card>
  );
}
