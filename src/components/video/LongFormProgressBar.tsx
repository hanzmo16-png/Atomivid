import { GenerationProgress } from "@/components/ui/GenerationProgress";
import { computeProductionProgress, isLongFormProgress, isProgressStageKey } from "@/lib/video/long-form/progress";

/** Same persisted measurement in history and production details. */
export function LongFormProgressBar({ stage, progress }: { stage: string | null; progress: unknown }) {
  const measurement = isLongFormProgress(progress) && progress.stage === stage ? progress : null;
  const percent = isProgressStageKey(stage) && (measurement !== null || stage !== "queued")
    ? computeProductionProgress({ stage, unitsCompleted: measurement?.unitsCompleted ?? 0, unitsTotal: measurement?.unitsTotal ?? 0 })
    : null;
  return <GenerationProgress label="Progreso de la producción" percent={percent} />;
}
