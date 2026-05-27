import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="flex flex-col gap-10">
      <div>
        <Skeleton className="mb-3 h-9 w-2/3" />
        <Skeleton className="mb-4 h-4 w-1/3" />
      </div>

      <section>
        <Skeleton className="mb-3 h-6 w-32" />
        <Skeleton className="h-20 w-full" />
      </section>

      <section>
        <Skeleton className="mb-3 h-6 w-40" />
        <Skeleton className="h-20 w-full" />
      </section>

      <section>
        <Skeleton className="mb-3 h-6 w-56" />
        <Skeleton className="h-20 w-full" />
      </section>

      <section>
        <Skeleton className="mb-3 h-6 w-64" />
        <Skeleton className="mb-3 h-12 w-full" />
        <Skeleton className="h-24 w-full" />
      </section>

      <section>
        <Skeleton className="mb-3 h-6 w-48" />
        <div className="flex flex-col gap-4">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      </section>
    </div>
  );
}
