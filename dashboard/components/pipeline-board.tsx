// no glossary terms in user-visible strings — column headings are state labels
// (spec-ready, implementing, pr-review, etc.) which don't match any glossary key.
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { FeatureItem, StateLabel } from '@/lib/pipeline';

const COLUMNS: StateLabel[] = [
  'state:spec-ready',
  'state:implementing',
  'state:pr-review',
  'state:staging-deployed',
  'state:ready-to-promote',
  'state:promoting',
  'state:blocked',
];

export function PipelineBoard({ items }: { items: FeatureItem[] }) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
        No in-flight features.
      </div>
    );
  }
  const grouped: Record<StateLabel, FeatureItem[]> = Object.fromEntries(
    COLUMNS.map((c) => [c, [] as FeatureItem[]]),
  ) as Record<StateLabel, FeatureItem[]>;
  for (const it of items) {
    if (grouped[it.state]) grouped[it.state].push(it);
  }

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:overflow-x-auto">
      {COLUMNS.map((state) => (
        <div key={state} className="flex w-full flex-shrink-0 flex-col gap-2 lg:w-72">
          <h3 className="text-sm font-semibold">{state.replace('state:', '')}</h3>
          {grouped[state].length === 0 ? (
            <div className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">empty</div>
          ) : (
            grouped[state].map((it) => (
              <Card key={`${it.repo}#${it.issue_number}`}>
                <CardHeader className="p-3 pb-1">
                  <CardTitle className="text-sm">
                    <Link
                      href={`/features/${it.issue_number}?repo=${encodeURIComponent(it.repo)}`}
                      className="hover:underline"
                    >
                      {it.title}
                    </Link>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-3 pt-0 text-xs text-muted-foreground">
                  <Badge variant="outline" className="mr-1">
                    {it.repo}
                  </Badge>
                  #{it.issue_number}
                </CardContent>
              </Card>
            ))
          )}
        </div>
      ))}
    </div>
  );
}
