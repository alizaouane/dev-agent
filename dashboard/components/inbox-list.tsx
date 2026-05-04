import Link from 'next/link';
import type { FeatureItem } from '@/lib/pipeline';
import { InboxItem } from '@/components/inbox-item';

export function InboxList({ items }: { items: FeatureItem[] }) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
        <p className="mb-3">All clear. Bring a new idea or check the pipeline.</p>
        <Link
          href="/intent"
          className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Brainstorm with PM
        </Link>
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
