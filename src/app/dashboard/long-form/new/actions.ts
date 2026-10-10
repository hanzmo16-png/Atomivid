"use server";

import { after } from "next/server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canAccessLongFormBeta } from "@/lib/video/long-form/private-access";
import { enqueueScriptJob, retryScriptJob } from "@/lib/video/long-form/script-jobs";
import { dispatchScriptJob } from "@/lib/video/long-form/script-job-dispatch";

const MIN_DURATION_MINUTES = 3;
const MAX_DURATION_MINUTES = 30;

/**
 * QA real (2026-09-25, "duration_seconds CHECK CONSTRAINT + FORM STATE
 * LOST ON ERROR"): tras el fix del submit silencioso, Hans vio el error
 * crudo de Postgres ("new row for relation ... violates check constraint
 * ...") y perdió tema/fuentes/preguntas al volver a la página. Todo
 * redirect recuperable de este formulario debe (a) llevar el mismo
 * mensaje visible de siempre y (b) devolver los valores ya escritos, para
 * que page.tsx los use como defaultValue — nunca solo "?error=...".
 */
function longFormFormRedirect(
  error: string,
  fields: { topic: string; durationMinutes: string; sources: string; openQuestions: string; language: string },
): never {
  const params = new URLSearchParams({
    error,
    topic: fields.topic,
    duration_minutes: fields.durationMinutes,
    sources: fields.sources,
    open_questions: fields.openQuestions,
    language: fields.language,
  });
  redirect(`/dashboard/long-form/new?${params.toString()}`);
}

export async function createLongFormVideoRequest(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");
  // Nunca confiar en que la página no se haya podido cargar sin este
  // acceso — se re-verifica en el servidor, igual que canPrepareAvatar()
  // ya se re-verifica en dashboard/new/actions.ts para el modo avatar.
  if (!canAccessLongFormBeta(user)) {
    redirect("/dashboard/new?error=Esta+función+beta+no+está+disponible+para+tu+cuenta");
  }

  const topic = String(formData.get("topic") ?? "").trim();
  const durationMinutesRaw = String(formData.get("duration_minutes") ?? "");
  const durationMinutes = Number(durationMinutesRaw);
  const sourcesRaw = String(formData.get("sources") ?? "");
  const openQuestionsRaw = String(formData.get("open_questions") ?? "");
  const language = String(formData.get("language") ?? "es");
  const submittedFields = { topic, durationMinutes: durationMinutesRaw, sources: sourcesRaw, openQuestions: openQuestionsRaw, language };

  if (language !== "es" && language !== "en") {
    longFormFormRedirect("Selecciona español o inglés para la narración.", submittedFields);
  }

  if (topic.length < 3 || topic.length > 200) {
    longFormFormRedirect("El tema debe tener entre 3 y 200 caracteres.", submittedFields);
  }
  if (!Number.isFinite(durationMinutes) || durationMinutes < MIN_DURATION_MINUTES || durationMinutes > MAX_DURATION_MINUTES) {
    longFormFormRedirect(
      `La duración debe estar entre ${MIN_DURATION_MINUTES} y ${MAX_DURATION_MINUTES} minutos.`,
      submittedFields,
    );
  }

  if (sourcesRaw.length > 12000 || openQuestionsRaw.length > 4000) {
    longFormFormRedirect("Acorta las referencias a 12.000 caracteres y las preguntas a 4.000.", submittedFields);
  }
  let job: {id:string;status:string};
  try {
    job = await enqueueScriptJob(supabase, user, { ...submittedFields, language });
  } catch {
    longFormFormRedirect("No se pudo guardar la preparación. No se inició ninguna generación; conserva los datos y vuelve al historial para comprobarlo.", submittedFields);
  }
  if (job.status === "queued") after(() => dispatchScriptJob(job.id));
  redirect(`/dashboard?script_job=${job.id}`);
}

/** Resume dispatch only for a persisted, owner-scoped QUEUED job. Never reset a
 * failed/running paid operation, create a new job or change its fingerprint. */
export async function resumeQueuedScriptJob(formData: FormData) {
  const client=await createClient();
  const {data:{user}}=await client.auth.getUser();
  if(!user) redirect("/login");
  if(!canAccessLongFormBeta(user)) redirect("/dashboard");
  const id=String(formData.get("job_id")??"");
  const {data:job}=await client.from("documentary_script_jobs").select("id,status,updated_at,error_message").eq("id",id).eq("user_id",user.id).maybeSingle();
  if(job?.status==="queued" && (job.error_message || Date.now()-Date.parse(job.updated_at)>90000)) after(()=>dispatchScriptJob(job.id));
  redirect("/dashboard");
}

/** Owner retry/resume/extra correction of a FAILED job (see retryPatch). The
 * same row is requeued once via compare-and-swap; nothing new is created. */
export async function retryFailedScriptJob(formData: FormData) {
  const client=await createClient();
  const {data:{user}}=await client.auth.getUser();
  if(!user) redirect("/login");
  if(!canAccessLongFormBeta(user)) redirect("/dashboard");
  const id=String(formData.get("job_id")??"");
  if(await retryScriptJob(user.id,id)==="queued") after(()=>dispatchScriptJob(id));
  redirect(`/dashboard/long-form/jobs/${encodeURIComponent(id)}`);
}
