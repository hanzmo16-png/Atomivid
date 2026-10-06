import { createServiceClient } from "@/lib/supabase/service";
/** Enqueues a job identifier only. No brief, account details or credentials in the public event. */
export async function dispatchScriptJob(id: string) {
 const token=process.env.GH_WORKER_TOKEN, repo=process.env.GH_WORKER_REPO;
 try {
  if (!token || !repo || !/^[^\s/]+\/[^\s/]+$/.test(repo)) throw new Error("Worker not configured");
  const response=await fetch(`https://api.github.com/repos/${repo}/dispatches`, { method:"POST",
   headers:{Authorization:`Bearer ${token}`,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"},
   body:JSON.stringify({event_type:"prepare-documentary-script",client_payload:{jobId:id}}),signal:AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Dispatch ${response.status}`);
 } catch {
  // Dispatch uncertainty is not a failed provider call: keep the SAME queued job.
  await createServiceClient().from("documentary_script_jobs").update({error_message:"El trabajo está guardado, pero no pudimos confirmar su inicio. Puedes reactivar la cola sin crear otra solicitud."}).eq("id",id).eq("status","queued");
 }
}
