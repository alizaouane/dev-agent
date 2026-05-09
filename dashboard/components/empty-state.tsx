import Link from 'next/link';

export function EmptyState({
  title,
  body,
  cta,
}: {
  title: string;
  body: string;
  cta?: { label: string; href: string };
}) {
  return (
    <div className="rounded-md border border-dashed border-border bg-card p-6 text-center">
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      {cta ? (
        <div className="mt-3">
          <Link
            href={cta.href}
            className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent"
          >
            {cta.label}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
