import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { directorActor } from "@/lib/production-intelligence/vfx-director/access";
import { ownedJob } from "@/lib/production-intelligence/vfx-director/jobs";
import { supabaseJobStore } from "@/lib/production-intelligence/vfx-director/store";
import { reviewView } from "@/lib/production-intelligence/vfx-director/review-view";
import { ReviewControls } from "./ReviewControls";
import { reviewMedia } from "@/lib/production-intelligence/vfx-director/review-media";

export const dynamic = "force-dynamic";
const labels: Record<string, string> = { approved: "Aprobado", rejected: "Defecto rechazado", review: "Pendiente de revisión", missing: "Material pendiente" };
export default async function VfxPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const { data: { user } } = await (await createClient()).auth.getUser();
  let actor: string;
  try { actor = directorActor(user); } catch { notFound(); }
  const service = createServiceClient();
  const { data, error } = await service.from("vfx_director_jobs").select("id").eq("owner_id", actor).order("created_at", { ascending: false });
  if (error) throw new Error("No se pudo cargar el Director VFX.");
  const { id } = await searchParams;
  const selected = id ?? data?.[0]?.id;
  const job = selected ? await ownedJob(supabaseJobStore(service), selected, actor) : null;
  const media = job ? await reviewMedia(service, job) : {};
  return <div className="space-y-6">
    <div><h1 className="text-2xl font-bold">Director VFX</h1><p className="mt-2 text-sm text-ink-muted">Cada entorno conserva su material, su luz y su revisión. Un defecto impide la composición final.</p></div>
    <nav aria-label="Proyectos VFX" className="flex flex-wrap gap-3">{data?.map(row => <Link key={row.id} href={`/dashboard/vfx?id=${encodeURIComponent(row.id)}`} className="underline">{row.id}</Link>)}</nav>
    {!job ? <p>No hay proyectos preparados.</p> : <>
      <section className="rounded-lg border border-border p-4"><h2 className="font-semibold">{job.brief.intent}</h2>
        <p className="mt-2 text-sm">{job.brief.frames / job.brief.fps}s · {job.brief.width} × {job.brief.height} · Revisión {job.revision}</p>
        <p className="mt-2 text-sm">Estado: {job.status}. {job.activeTask && `Tarea activa: ${job.activeTask}.`}</p>
        {job.error && <p role="alert" className="mt-2 text-sm">La ejecución está bloqueada; requiere revisar la tarea y sus materiales.</p>}
        <p className="mt-2 text-sm text-ink-muted">La ejecución permanece en el worker protegido. Las revisiones de esta página se guardan sobre la huella exacta de cada versión.</p>
      </section>
      {job.plan.environments.map(environment => <section key={environment.id} className="rounded-lg border border-border p-4">
        <h2 className="text-lg font-semibold">{environment.id}</h2><p className="mt-1 text-sm">{environment.light}</p>
        <p className="mt-1 text-sm text-ink-muted">Fotogramas {environment.startFrame}–{environment.endFrame - 1} · {environment.continuityIn} → {environment.continuityOut}</p>
        <div className="mt-4 space-y-4">{reviewView(job, environment.id).map(item => <article key={item.stage}>
          <h3 className="font-medium">{item.label}: {labels[item.state]}</h3>
          {media[`${environment.id}:${item.stage}`] ? <a href={media[`${environment.id}:${item.stage}`]} target="_blank" rel="noopener noreferrer" className="my-2 block text-sm underline">Abrir material de esta versión</a> : <p className="mt-1 text-sm text-ink-muted">Vista previa de esta versión pendiente de vincular. No se puede aprobar desde esta pantalla sin el material.</p>}
          {item.evidence.map(check => <p key={check.name} className="mt-1 text-sm text-ink-muted">{check.name}: {check.evidence}</p>)}
          <ReviewControls jobId={job.id} environmentId={environment.id} item={item} materialAvailable={Boolean(media[`${environment.id}:${item.stage}`])} />
        </article>)}</div>
      </section>)}
      <section className="rounded-lg border border-border p-4"><h2 className="text-lg font-semibold">Composición final</h2>
        <p className="mt-1 text-sm text-ink-muted">Cortes entre entornos aprobados. Grano una sola vez sobre todo el cuadro.</p>
        {reviewView(job).map(item => <article key={item.stage}><p className="mt-3">{labels[item.state]}</p><p className="mt-1 text-sm text-ink-muted">El archivo de esta composición debe vincularse antes de una nueva aprobación desde la página.</p><ReviewControls jobId={job.id} item={item} materialAvailable={false} /></article>)}
      </section>
    </>}
  </div>;
}
