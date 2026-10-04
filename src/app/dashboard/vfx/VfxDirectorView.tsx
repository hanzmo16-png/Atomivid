import Link from "next/link";
import type { Job } from "@/lib/production-intelligence/vfx-director/jobs";
import { reviewView, checkLabel } from "@/lib/production-intelligence/vfx-director/review-view";
import { environmentName, JOB_STATUS_LABELS, taskName, type ExecutionView } from "@/lib/production-intelligence/vfx-director/execution";
import { projectName, projectDescription, lightingText } from "@/lib/production-intelligence/vfx-director/display";
import { ReviewControls } from "./ReviewControls";
import { ExecutionControls } from "./ExecutionControls";
import { VfxProgress } from "./VfxProgress";

const labels: Record<string, string> = { approved: "Aprobado", rejected: "Defecto rechazado", review: "Pendiente de revisión", missing: "Material pendiente" };
function MaterialPreview({ url }: { url: string }) {
  const pathname = new URL(url).pathname;
  return <div className="my-3 min-w-0">
    {/\.mp4$/.test(pathname) ? <video controls playsInline preload="metadata" src={url} className="max-h-96 w-full max-w-full rounded-lg" />
      // eslint-disable-next-line @next/next/no-img-element -- short-lived signed private URL; must not pass through the image optimizer
      : <img src={url} alt="Material de la versión en revisión" className="max-h-96 w-full max-w-full rounded-lg object-contain" />}
    <a href={url} target="_blank" rel="noopener noreferrer" className="mt-2 block text-sm underline">Abrir material de esta versión</a>
  </div>;
}
/** Presentation only; the page loads and authorizes the data. */
export function VfxDirectorView({ projects, job, media, execution }: { projects: string[]; job: Job | null; media: Record<string, string>; execution: ExecutionView | null }) {
  return <div className="min-w-0 max-w-full space-y-6 overflow-x-hidden break-words">
    <div><h1 className="text-2xl font-bold">Director VFX</h1><p className="mt-2 text-sm text-ink-muted">Cada entorno conserva su material, su luz y su revisión. Un defecto impide la composición final.</p></div>
    <nav aria-label="Proyectos VFX" className="flex flex-wrap gap-x-4 gap-y-2">{projects.map(id => <Link key={id} href={`/dashboard/vfx?id=${encodeURIComponent(id)}`} aria-current={id === job?.id ? "page" : undefined} className="underline">{projectName(id)}</Link>)}</nav>
    {!job || !execution ? <p>No hay proyectos preparados.</p> : <>
      <section className="min-w-0 rounded-lg border border-border p-4"><h2 className="font-semibold">{projectName(job.id)}</h2>
        <p className="mt-1 text-sm text-ink-muted">{projectDescription(job.id, job.brief.intent)}</p>
        <p className="mt-2 text-sm">{job.brief.frames / job.brief.fps} s · {job.brief.width} × {job.brief.height} · Revisión {job.revision}</p>
        <p className="mt-2 text-sm">Estado: <strong>{JOB_STATUS_LABELS[job.status]}</strong>{job.activeTask && ` · Tarea activa: ${taskName(job, job.activeTask)}`}</p>
        <VfxProgress job={job} />
        {job.error && <p role="alert" className="mt-2 text-sm">La ejecución está bloqueada; requiere revisar la tarea y sus materiales.</p>}
        <details className="mt-2 text-sm text-ink-muted"><summary className="cursor-pointer">Detalles de auditoría</summary>
          <p className="break-all">Proyecto: {job.id}</p><p className="break-all">Huella del plan: {job.planHash}</p>
          <p>Aprobaciones registradas: {job.approvals.length} · Resultados medidos: {Object.keys(job.results).length} de {job.plan.tasks.length}</p>
          {job.error && <p className="break-all">Código: {job.error}</p>}
        </details>
      </section>
      <section className="min-w-0 rounded-lg border border-border p-4"><h2 className="text-lg font-semibold">Ejecución</h2>
        <p className="mt-1 text-sm text-ink-muted">Se ejecuta una tarea por vez en el worker protegido, con los ejecutores configurados en el servidor. Cada solicitud queda registrada antes de enviarse y nunca se repite sola.</p>
        <ExecutionControls jobId={job.id} revision={job.revision} planHash={job.planHash} view={execution} />
      </section>
      {job.plan.environments.map(environment => <section key={environment.id} className="min-w-0 rounded-lg border border-border p-4">
        <h2 className="text-lg font-semibold">{environmentName(environment.id)}</h2><p className="mt-1 text-sm">Luz propia de este entorno.</p>
        <details className="mt-2 text-sm text-ink-muted"><summary className="cursor-pointer">Dirección y continuidad</summary><p>{lightingText(environment.light)}</p><p>Fotogramas {environment.startFrame}–{environment.endFrame - 1} · {environment.continuityIn} → {environment.continuityOut}</p></details>
        <div className="mt-4 space-y-4">{reviewView(job, environment.id).map(item => <article key={item.stage} className="min-w-0">
          <h3 className="font-medium">{item.label}: {labels[item.state]}</h3>
          {media[`${environment.id}:${item.stage}`] ? <MaterialPreview url={media[`${environment.id}:${item.stage}`]} /> : <p className="mt-1 text-sm text-ink-muted">Vista previa de esta versión pendiente de vincular. No se puede aprobar desde esta pantalla sin el material.</p>}
          <details className="mt-2 text-sm text-ink-muted"><summary className="cursor-pointer">Comprobaciones de esta versión</summary>
            {item.evidence.length ? item.evidence.map(check => <p key={check.name} className="mt-1 break-words"><strong>{checkLabel(check.name)}:</strong> {check.evidence}</p>) : <p className="mt-1">Sin revisión registrada.</p>}
            {item.sha256 && <p className="mt-2 break-all">Huella del material: {item.sha256}</p>}
          </details>
          <ReviewControls jobId={job.id} environmentId={environment.id} item={item} materialAvailable={Boolean(media[`${environment.id}:${item.stage}`])} />
        </article>)}</div>
      </section>)}
      {job.plan.tasks.every(t => t.stage === "preview") ? <section className="min-w-0 rounded-lg border border-border p-4">
        <h2 className="text-lg font-semibold">Material de prueba</h2>
        {media["global:preview"] ? <MaterialPreview url={media["global:preview"]} /> : <p className="mt-2 text-sm text-ink-muted">La vista previa aparecerá cuando termine la prueba de composición.</p>}
        <p className="mt-2 text-sm text-ink-muted">La prueba no aprueba ni sustituye el video de la precampaña.</p>
      </section> : <section className="min-w-0 rounded-lg border border-border p-4"><h2 className="text-lg font-semibold">Composición final</h2>
        <p className="mt-1 text-sm text-ink-muted">Cortes entre entornos aprobados. Grano una sola vez sobre todo el cuadro.</p>
        {reviewView(job).map(item => <article key={item.stage} className="min-w-0"><p className="mt-3">{labels[item.state]}</p>{media[`global:${item.stage}`] ? <MaterialPreview url={media[`global:${item.stage}`]} /> : <p className="mt-1 text-sm text-ink-muted">El archivo de esta composición debe vincularse antes de una nueva aprobación desde la página.</p>}
          <details className="mt-2 text-sm text-ink-muted"><summary className="cursor-pointer">Comprobaciones de esta versión</summary>
            {item.evidence.length ? item.evidence.map(check => <p key={check.name} className="mt-1 break-words"><strong>{checkLabel(check.name)}:</strong> {check.evidence}</p>) : <p className="mt-1">Sin revisión registrada.</p>}
            {item.sha256 && <p className="mt-2 break-all">Huella del material: {item.sha256}</p>}
          </details>
          <ReviewControls jobId={job.id} item={item} materialAvailable={Boolean(media[`global:${item.stage}`])} /></article>)}
      </section>}
    </>}
  </div>;
}
