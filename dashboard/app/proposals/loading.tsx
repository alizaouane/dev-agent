import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div>
      <Skeleton className="mb-3 h-9 w-1/3" />
      <Skeleton className="mb-6 h-4 w-2/3" />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    </div>
  );
}
