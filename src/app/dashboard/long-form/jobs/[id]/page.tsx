import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ScriptJobCard } from "@/components/video/ScriptJobCard";
import { DocumentaryDraftView } from "@/components/video/DocumentaryDraftView";
import { AutoRefresh } from "@/app/dashboard/AutoRefresh";
import { Alert } from "@/components/ui/Alert";
import { scriptJobView, SCRIPT_JOB_COLUMNS, type ScriptJobSummary } from "@/lib/video/long-form/script-job-types";
import { reconcileStaleScriptJobs } from "@/lib/video/long-form/script-jobs";
import type { CreativeHistoryEntry } from "@/lib/video/long-form/creative-direction";
export default async function ScriptJobPage({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<{existing?:string}>}) {
 const {id}=await params, {existing}=await searchParams, client=await createClient();
 const {data:{user}}=await client.auth.getUser();
 if(!user) redirect("/login");
 // A dead worker becomes a persisted "interrupted" state, never endless loading.
 await reconcileStaleScriptJobs(user.id).catch(()=>{});
 const {data,error}=await client.from("documentary_script_jobs")
  .select(`${SCRIPT_JOB_COLUMNS},editorial_checkpoint,creative_history:input->creativeHistory`).eq("id",id).eq("user_id",user.id).maybeSingle();
 if(error) return <p role="alert">No se pudo consultar el estado. El trabajo guardado no se reinicia; vuelve al historial en un momento.</p>;
 if(!data) notFound();
 const job=data as ScriptJobSummary;
 // This authenticated Server Component computes staleness once per request.
 // eslint-disable-next-line react-hooks/purity
 const now=Date.now();
 return <div><h1 className="mb-4 text-2xl font-bold">Preparación del documental</h1>
  {existing==="1" && <div className="mb-4"><Alert tone="info">Ya tenías una preparación con exactamente estos datos: es esta. No se creó otra ni se cobró nada. Para un guion distinto, cambia el tema, la duración o las referencias.</Alert></div>}
  <AutoRefresh active={scriptJobView(job,now).refresh}/><ScriptJobCard job={job} nowMs={now}/>
  {job.status!=="completed" && <DocumentaryDraftView value={data.editorial_checkpoint} history={Array.isArray(data.creative_history)?data.creative_history as unknown as CreativeHistoryEntry[]:[]}/>}</div>;
}
