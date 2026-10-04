import { RENDER_STAGES } from "@/lib/video/stages";

/** Reports completed pipeline stages, not elapsed time or rendered frames. */
export function ReelProgressBar({ stage }: { stage: string | null }) {
  const completed = RENDER_STAGES.findIndex((value) => value === stage);
  const percent = completed < 0 ? null : Math.round(completed / RENDER_STAGES.length * 100);

  return (
    <div className="mt-3 w-full min-w-0 text-left">
      <div className="mb-1.5 flex items-center justify-between gap-3 text-xs text-ink-muted">
        <span>Progreso por etapas</span>
        <span className="shrink-0 tabular-nums">{percent === null ? "Preparando…" : `${percent}%`}</span>
      </div>
      <div
        role="progressbar"
        aria-label="Progreso de generación del reel"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={percent === null ? "Esperando información de progreso" : `${completed} de ${RENDER_STAGES.length} etapas completadas`}
        className="h-2 w-full overflow-hidden rounded-full bg-surface-raised"
      >
        <div
          className={percent === null
            ? "h-full w-1/3 animate-pulse rounded-full bg-accent motion-reduce:animate-none"
            : "h-full rounded-full bg-accent transition-[width] duration-500 motion-reduce:transition-none"}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
