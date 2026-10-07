import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { resumeQueuedScriptJob, retryFailedScriptJob } from "@/app/dashboard/long-form/new/actions";
import { scriptJobView, type ScriptJobSummary } from "@/lib/video/long-form/script-job-types";
export function ScriptJobCard({job,nowMs}:{job:ScriptJobSummary;nowMs:number}) {
 const view=scriptJobView(job,nowMs);
 return <Card className="p-4 sm:p-5">
  <div className="flex flex-wrap items-center justify-between gap-3">
   <Link href={`/dashboard/long-form/jobs/${job.id}`} className="font-medium text-ink hover:text-accent">{job.topic}</Link>
   <Badge tone={view.kind==="technical"?"danger":view.kind?"warning":view.refresh?"info":"warning"}>{view.label}</Badge>
  </div>
  <p className="mt-2 text-sm text-ink-muted">{job.stage} · {new Date(job.created_at).toLocaleString("es-MX")}</p>
  {view.message ? <p className="mt-2 text-sm text-warning" role="status">{view.message}</p> :
   <p className="mt-2 text-sm text-ink-muted">Tu trabajo está guardado. Puedes salir y volver a consultar el progreso aquí.</p>}
  {job.status==="queued" && (job.error_message || nowMs-Date.parse(job.updated_at)>90000) ?
   <form action={resumeQueuedScriptJob} className="mt-3"><input type="hidden" name="job_id" value={job.id}/>
    <button type="submit" className="rounded-md bg-accent px-3 py-2 text-sm text-accent-ink">Reactivar trabajo guardado</button>
   </form>:null}
  {view.action ?
   <form action={retryFailedScriptJob} className="mt-3"><input type="hidden" name="job_id" value={job.id}/>
    <button type="submit" className="rounded-md bg-accent px-3 py-2 text-sm text-accent-ink">{view.action}</button>
   </form>:null}
  {job.status==="completed" ? <Link href={`/dashboard/long-form/configure/${job.request_id}`} className="mt-3 inline-block text-accent underline">Revisar y configurar producción</Link>:null}
 </Card>;
}
