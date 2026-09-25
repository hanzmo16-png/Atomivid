import { Card } from "@/components/ui/Card";
import { LONG_FORM_STAGES, LONG_FORM_STAGE_LABEL, type LongFormStage } from "@/lib/video/long-form/stages";
import {
  computeProductionProgress,
  estimateRemainingRangeSeconds,
  formatRemainingRange,
  isLongFormProgress,
  type ProgressStageKey,
} from "@/lib/video/long-form/progress";

/**
 * RC mission "LONG FORM RC FINAL HARDENING" (secciones 22-34) — reemplaza
 * la tarjeta genérica "Preparando tu video..." (que en producción se
 * quedó fija >15 minutos sin más información, ver diagnóstico de la
 * solicitud de Panamá) por progreso REAL derivado de long_form_stage +
 * long_form_progress. Nunca inventa un porcentaje: si la fila no tiene
 * long_form_progress todavía (fila anterior a esta migración, o apenas
 * empezando), unitsTotal queda en 0 y computeProductionProgress()
 * devuelve el INICIO del rango de la etapa actual — un número real
 * (basado en la etapa), nunca una cuenta regresiva ni un 0% falso para un
 * trabajo que sí está avanzando.
 */
export function ProductionProgressCard({
  longFormStage,
  longFormProgress,
}: {
  longFormStage: string | null;
  longFormProgress: unknown;
}) {
  const stage: ProgressStageKey = (longFormStage as LongFormStage | null) ?? "queued";
  const progress = isLongFormProgress(longFormProgress) ? longFormProgress : null;
  const unitsCompleted = progress?.unitsCompleted ?? 0;
  const unitsTotal = progress?.unitsTotal ?? 0;
  const percent = computeProductionProgress({ stage, unitsCompleted, unitsTotal });
  const etaRange = estimateRemainingRangeSeconds({ stage, unitsCompleted, unitsTotal });
  const etaText = formatRemainingRange(etaRange);

  return (
    <Card className="p-6 text-center">
      <p className="font-medium text-ink">
        {LONG_FORM_STAGE_LABEL[stage as LongFormStage] ?? "Preparando tu documental"}…
      </p>
      {progress && unitsTotal > 0 && (
        <p className="mt-1 text-sm text-ink-muted">
          {progress.unitLabel}: {unitsCompleted}/{unitsTotal}
        </p>
      )}

      <div className="mt-4">
        <div className="h-2 w-full overflow-hidden rounded-full bg-surface-raised" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
        </div>
        <p className="mt-1.5 text-xs text-ink-faint">{percent}%</p>
      </div>

      <ul className="mt-5 flex flex-col items-start gap-1.5 text-left text-sm">
        {LONG_FORM_STAGES.map((s) => {
          const stageIndex = LONG_FORM_STAGES.indexOf(s);
          const currentIndex = LONG_FORM_STAGES.indexOf(stage as LongFormStage);
          const done = currentIndex !== -1 && stageIndex < currentIndex;
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

      <p className="mt-5 text-sm text-ink-muted">{etaText}</p>
      <p className="mt-1 text-xs text-ink-faint">
        Puedes cerrar esta página — el progreso se guarda y lo verás reflejado aquí al volver.
      </p>
    </Card>
  );
}
