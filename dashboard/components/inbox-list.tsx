import type { FeatureItem } from '@/lib/pipeline';
import { InboxItem } from '@/components/inbox-item';

export function InboxList({ items }: { items: FeatureItem[] }) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
        All clear — drop new intent or check the pipeline.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => (
        <InboxItem key={`${item.repo}#${item.issue_number}`} item={item} />
      ))}
    </div>
  );
}
