import { GenerationProgress } from "@/components/ui/GenerationProgress";
import type { Job } from "@/lib/production-intelligence/vfx-director/jobs";

/** Count only outputs registered for tasks in the current plan. */
export function VfxProgress({ job }: { job: Pick<Job, "plan" | "results" | "status"> }) {
  const total = job.plan.tasks.length;
  const completed = job.plan.tasks.filter(task => Boolean(job.results[task.id])).length;
  return <GenerationProgress label="Tareas de producción VFX" percent={total > 0 ? completed / total * 100 : null}
    detail={`${completed} de ${total} tareas con resultado registrado${job.status === "BLOCKED" || job.status === "FAILED" ? " · Ejecución detenida" : ""}`} />;
}
