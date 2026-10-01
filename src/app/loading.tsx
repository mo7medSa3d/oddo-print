/**
 * Route-level loading state: the same page geometry the console renders, so
 * navigation never flashes an empty screen or a layout jump.
 */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8" role="status" aria-label="Loading">
      <div className="space-y-3">
        <div className="skeleton h-7 w-56" />
        <div className="skeleton h-4 w-full max-w-lg" />
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-xl border border-edge bg-surface p-4 shadow-card">
            <div className="skeleton h-2.5 w-20" />
            <div className="skeleton mt-3.5 h-6 w-16" />
            <div className="skeleton mt-3 h-2.5 w-28" />
          </div>
        ))}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="card overflow-hidden">
            <div className="border-b border-edge-subtle px-5 py-4">
              <div className="skeleton h-3.5 w-32" />
              <div className="skeleton mt-2 h-2.5 w-44" />
            </div>
            <div className="space-y-3 px-5 py-5">
              <div className="skeleton h-9 w-full" />
              <div className="skeleton h-9 w-[88%]" />
              <div className="skeleton h-9 w-[76%]" />
            </div>
          </div>
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
