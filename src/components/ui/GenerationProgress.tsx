import { LogoMark } from "./Logo";

/** The atom's outer orbit fills clockwise from noon using measured progress. */
export function GenerationProgress({ label, percent = null, detail }: {
  label: string;
  percent?: number | null;
  detail?: string;
}) {
  const value = percent !== null && Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null;
  return <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={value ?? undefined}
      aria-valuetext={detail ?? (value === null ? "Esperando información de progreso" : `${value}%`)}
      className="mt-3 flex w-full min-w-0 items-center gap-3 text-left">
    <div className="relative size-16 shrink-0" aria-hidden="true">
      <svg viewBox="0 0 64 64" fill="none" className={`size-full text-accent ${value === null ? "animate-spin motion-reduce:animate-none" : ""}`}>
        <circle cx="32" cy="32" r="29" stroke="currentColor" strokeWidth="2" className="opacity-15" />
        <circle cx="32" cy="32" r="29" pathLength="100" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
          strokeDasharray="100" strokeDashoffset={value === null ? 76 : 100 - value}
          transform="rotate(-90 32 32)"
          className="transition-[stroke-dashoffset] duration-700 motion-reduce:transition-none"
          opacity={value === 0 ? 0 : 1} />
        {value !== null && value > 0 && value < 100 && <g transform={`rotate(${value * 3.6 - 90} 32 32)`}>
          <circle cx="61" cy="32" r="3" fill="currentColor" />
        </g>}
      </svg>
      <span className="absolute inset-0 flex items-center justify-center"><LogoMark size={36} /></span>
    </div>
    <div className="min-w-0">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums text-accent">{value === null ? "En curso…" : `${value}%`}</p>
      {detail && <p className="mt-0.5 text-xs text-ink-faint">{detail}</p>}
    </div>
  </div>;
}
