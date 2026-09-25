import { Card } from "@/components/ui/Card";
import { LONG_FORM_STAGES, LONG_FORM_STAGE_LABEL, type LongFormStage } from "@/lib/video/long-form/stages";
import {
  VISIBLE_PROGRESS_STAGES,
  computeProductionProgress,
  estimateRemainingRangeSeconds,
  formatRemainingRange,
  isLongFormProgress,
  type ProgressStageKey,
} from "@/lib/video/long-form/progress";

/**
 * Progreso REAL de una producción Long Form, reconstruido 100% desde la
 * base de datos (long_form_stage + long_form_progress) — un refresh, otro
 * dispositivo o volver desde Historial muestran exactamente lo mismo.
 * Sin long_form_progress (fila anterior a la migración 0019 o recién
 * encolada) se muestra solo la etapa real: nunca un porcentaje inventado.
 * Solo se renderiza mientras status === "processing": nunca muestra 100%
 * (eso lo muestra el estado "completed") ni un fallo (lo muestra "failed").
 */
export function ProductionProgressCard({
  longFormStage,
  longFormProgress,
  nowMs,
}: {
  longFormStage: string | null;
  longFormProgress: unknown;
  /** Reloj inyectado por el caller (Server Component) — nunca Date.now() dentro del render. */
  nowMs: number;
}) {
  const stage: ProgressStageKey =
    longFormStage && (LONG_FORM_STAGES as readonly string[]).includes(longFormStage) ? (longFormStage as LongFormStage) : "queued";
  const progress = isLongFormProgress(longFormProgress) && longFormProgress.stage === stage ? longFormProgress : null;
  const unitsCompleted = progress?.unitsCompleted ?? 0;
  const unitsTotal = progress?.unitsTotal ?? 0;
  const hasEvidence = progress !== null || stage !== "queued";
  const percent = computeProductionProgress({ stage, unitsCompleted, unitsTotal });
  const eta = formatRemainingRange(
    progress ? estimateRemainingRangeSeconds({ ...progress, stage }, nowMs) : null,
  );
  const currentIndex = VISIBLE_PROGRESS_STAGES.indexOf(stage as LongFormStage);

  return (
    <Card className="p-5 sm:p-6">
      <p className="font-medium text-ink">
        {stage === "queued" ? "En cola — el trabajo empezará en unos instantes" : `${LONG_FORM_STAGE_LABEL[stage as LongFormStage]}…`}
      </p>
      {progress && unitsTotal > 0 && (
        <p className="mt-1 text-sm text-ink-muted">
          {unitsCompleted}/{unitsTotal} {progress.unitLabel}
        </p>
      )}

      {hasEvidence && (
        <div className="mt-4">
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-surface-raised"
            role="progressbar"
            aria-label="Progreso de la producción"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${percent}%` }} />
          </div>
          <p className="mt-1.5 text-xs text-ink-faint">{percent}%</p>
        </div>
      )}

      <ul className="mt-5 flex flex-col gap-1.5 text-sm">
        {VISIBLE_PROGRESS_STAGES.map((s, i) => {
          const done = currentIndex !== -1 && i < currentIndex;
          const active = s === stage;
          return (
            <li key={s} className="flex items-center gap-2">
              <span className={done ? "text-success" : active ? "text-accent" : "text-ink-faint"} aria-hidden="true">
                {done ? "✓" : active ? "●" : "○"}
              </span>
              <span className={active ? "font-medium text-ink" : "text-ink-muted"}>{LONG_FORM_STAGE_LABEL[s]}</span>
            </li>
          );
        })}
      </ul>

      <p className="mt-5 text-sm text-ink-muted">{eta}</p>
      <p className="mt-1 text-xs text-ink-faint">
        Puedes cerrar esta página — el progreso se guarda y lo verás aquí o en tu historial al volver.
      </p>
    </Card>
  );
}
