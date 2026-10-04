/** Shared indicator. A missing measurement stays indeterminate, never timed. */
export function GenerationProgress({ label, percent = null, detail }: {
  label: string;
  percent?: number | null;
  detail?: string;
}) {
  const value = percent !== null && Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null;
  return <div className="mt-3 w-full min-w-0 text-left">
    <div className="mb-1.5 flex items-center justify-between gap-3 text-xs text-ink-muted">
      <span className="min-w-0">{label}</span>
      <span className="shrink-0 tabular-nums">{value === null ? "En curso…" : `${value}%`}</span>
    </div>
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={value ?? undefined}
      aria-valuetext={detail ?? (value === null ? "Esperando información de progreso" : `${value}%`)}
      className="h-2 w-full overflow-hidden rounded-full bg-surface-raised">
      <div className={value === null
        ? "h-full w-1/3 animate-pulse rounded-full bg-accent motion-reduce:animate-none"
        : "h-full rounded-full bg-accent transition-[width] duration-500 motion-reduce:transition-none"}
        style={value === null ? undefined : { width: `${value}%` }} />
    </div>
    {detail && <p className="mt-1.5 text-xs text-ink-faint">{detail}</p>}
  </div>;
}
