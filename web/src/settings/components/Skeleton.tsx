export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`rounded bg-fill-interactive ${className}`} />;
}

export function HomeSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-5">
      <Skeleton className="h-7 w-44 mb-6" />
      <div className="grid grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((key) => (
          <div
            key={key}
            className="flex flex-col justify-between h-24 p-4 rounded-xl bg-surface-card border border-border"
          >
            <Skeleton className="h-5 w-12" />
            <Skeleton className="h-3 w-16 self-end max-w-full" />
          </div>
        ))}
      </div>
      <Skeleton className="h-56 rounded-xl" />
      <Skeleton className="h-28 rounded-xl" />
    </div>
  );
}

export function LibrarySkeleton() {
  return (
    <div aria-busy="true" className="space-y-4">
      <div
        aria-hidden="true"
        className="overflow-hidden rounded-lg border border-border bg-surface-card"
      >
        {[0, 1, 2].map((key) => (
          <div
            key={key}
            className="flex h-12 items-center px-3 border-b border-border-subtle last:border-b-0"
          >
            <Skeleton className="h-4 w-36" />
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="flex h-8 items-center gap-3">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-24" />
      </div>
    </div>
  );
}
