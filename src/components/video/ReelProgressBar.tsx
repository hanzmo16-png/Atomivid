import { RENDER_STAGES } from "@/lib/video/stages";
import { GenerationProgress } from "@/components/ui/GenerationProgress";

/** Reports completed pipeline stages, not elapsed time or rendered frames. */
export function ReelProgressBar({ stage, avatar = false }: { stage: string | null; avatar?: boolean }) {
  // Avatar has no footage/music stages. Recovery resumes at the provider stage.
  const stages: readonly string[] = avatar ? ["queued", "voice", "render", "uploading"] : RENDER_STAGES;
  const completed = stages.findIndex((value) => value === stage);
  const percent = completed < 0 ? null : Math.round(completed / stages.length * 100);
  return <GenerationProgress label={`Progreso por etapas del ${avatar ? "avatar" : "reel"}`} percent={percent}
    detail={completed < 0 ? undefined : `${completed} de ${stages.length} etapas completadas`} />;
}
