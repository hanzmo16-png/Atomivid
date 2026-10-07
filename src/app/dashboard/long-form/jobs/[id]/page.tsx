import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ScriptJobCard } from "@/components/video/ScriptJobCard";
import { DocumentaryDraftView } from "@/components/video/DocumentaryDraftView";
import { AutoRefresh } from "@/app/dashboard/AutoRefresh";
import { scriptJobView, type ScriptJobSummary } from "@/lib/video/long-form/script-job-types";
export default async function ScriptJobPage({params}:{params:Promise<{id:string}>}) {
 const {id}=await params, client=await createClient();
 const {data:{user}}=await client.auth.getUser();
 if(!user) redirect("/login");
 const {data,error}=await client.from("documentary_script_jobs")
  .select("id,topic,status,stage,error_message,request_id,created_at,updated_at,editorial_checkpoint").eq("id",id).eq("user_id",user.id).maybeSingle();
 if(error) return <p role="alert">No se pudo consultar el estado. El trabajo guardado no se reinicia; vuelve al historial en un momento.</p>;
 if(!data) notFound();
 const job=data as ScriptJobSummary;
 // This authenticated Server Component computes staleness once per request.
 // eslint-disable-next-line react-hooks/purity
 const now=Date.now();
 return <div><h1 className="mb-4 text-2xl font-bold">Preparación del documental</h1>
  <AutoRefresh active={scriptJobView(job,now).refresh}/><ScriptJobCard job={job} nowMs={now}/>
  {job.status!=="completed" && <DocumentaryDraftView value={data.editorial_checkpoint}/>}</div>;
}
