/** Ensayo LOCAL de autonomía editorial (USD 0): cada tema entra por enqueueScriptJob (el mismo que usa el formulario) o
 * por un JOB_ID ya creado desde la UI, y avanza SOLO con runScriptJobStep — el mismo paso que ejecuta el worker de
 * GitHub, una llamada nueva al proveedor por invocación — contra el Anthropic simulado (mock-documentary-anthropic.ts)
 * con el ledger real activo (SUPPLY_GUARD_ENFORCED). Nadie pulsa botones: si el guion se aprueba, el pedido queda en
 * script_ready; si se agotan las correcciones automáticas, queda la objeción con su diagnóstico.
 * Opcional: CRASH_AT_STEP=n mata el proceso hijo en mitad de ese paso para probar la recuperación.
 * Uso: TOPICS="Voyager 1|Misterios del océano profundo" MINUTES=9 npx tsx scripts/harness/e2e/longform-rehearsal/h-autonomy.ts */
import { createClient } from "@supabase/supabase-js";
import { enqueueScriptJob, runScriptJobStep } from "@/lib/video/long-form/script-jobs";

const OWNER = { id: process.env.OWNER_ID ?? "11111111-1111-4111-8111-111111111111", email: "pilot-owner@local.test", email_confirmed_at: "2026-01-01T00:00:00Z" };
for (const k of ["ANTHROPIC_BASE_URL"]) if (!/^http:\/\/127\.0\.0\.1:/.test(process.env[k] ?? "")) throw Error(`${k} debe apuntar al simulador local`);
if (!/^local-fake/.test(process.env.ANTHROPIC_API_KEY ?? "")) throw Error("ANTHROPIC_API_KEY debe ser una clave falsa local");
const LEDGER = process.env.SUPPLY_GUARD_ENFORCED === "true"; console.log("MODE", LEDGER ? "ledger real (una llamada nueva por paso)" : "modo local por defecto (sin ledger: todas las llamadas en un paso)");

const service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const topics = (process.env.TOPICS ?? "").split("|").map(s => s.trim()).filter(Boolean);

async function drive(id: string, tag: string) {
  const steps: string[] = [];
  for (let step = 1; step <= 80; step++) {
    const r = await runScriptJobStep(id, service) as { state: string };
    const { data: row } = await service.from("documentary_script_jobs").select("status,stage,editorial_checkpoint,error_message,failure_kind").eq("id", id).single();
    const cp = row?.editorial_checkpoint as { pass?: number; issues?: { source: string }[] } | null;
    steps.push(r.state);
    console.log("STEP", JSON.stringify({ tag, step, state: r.state, stage: row?.stage, pass: cp?.pass ?? null, issues: cp?.issues?.map(i => i.source) ?? null }));
    if (r.state === "completed" || r.state === "failed") {
      const { data: job } = await service.from("documentary_script_jobs").select("request_id,status,failure_kind,error_message").eq("id", id).single();
      const { data: vr } = await service.from("video_requests").select("status,duration_seconds,language,script_json").eq("id", job!.request_id).single();
      const ed = (vr?.script_json as { editorial?: { corrected: boolean; reviews: unknown[] } } | null)?.editorial;
      console.log("RESULT", JSON.stringify({ tag, jobId: id, requestId: job!.request_id, job: job!.status, failure: job!.failure_kind, message: job!.error_message,
        video: vr?.status, seconds: vr?.duration_seconds, language: vr?.language, reviews: ed?.reviews.length ?? null, corrected: ed?.corrected ?? null, steps: steps.length }));
      return;
    }
    if (r.state !== "queued" && r.state !== "waiting") { console.log("RESULT", JSON.stringify({ tag, jobId: id, unexpected: r.state, steps: steps.length })); return; }
  }
}

(async () => {
  if (process.env.JOB_ID) return drive(process.env.JOB_ID, process.env.TAG ?? "ui");
  for (const topic of topics) {
    const job = await enqueueScriptJob(service, OWNER, { topic, durationMinutes: process.env.MINUTES ?? "9", language: "es", sources: "", openQuestions: "" }, service);
    console.log("ENQUEUED", JSON.stringify({ topic, id: job.id, status: job.status }));
    await drive(job.id, topic);
  }
})().catch(e => { console.error("H_AUTONOMY_FAILED", e instanceof Error ? `${e.name}: ${e.message}` : e); process.exit(1); });
