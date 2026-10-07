import { z } from "zod";
import type { CreativeHistoryEntry } from "./creative-direction";
export const ScriptJobFieldsSchema = z.object({
 topic: z.string().trim().min(3).max(200),
 durationMinutes: z.string().refine(v => Number.isFinite(Number(v)) && Number(v)>=3 && Number(v)<=15),
 sources: z.string().max(12000), openQuestions: z.string().max(4000), language: z.enum(["en","es"]),
});
export type ScriptJobFields = z.infer<typeof ScriptJobFieldsSchema>;
export type ScriptJobInput = { fields: ScriptJobFields; creativeHistory: CreativeHistoryEntry[]; recoverLegacyOperator: boolean; referenceContract?: "catalog-v1"; writerContract?: "fragments-v1" };
export type ScriptJobSummary = { id: string; topic: string; status: string; stage: string; error_message: string | null; request_id: string; created_at: string; updated_at: string;
 failure_kind?: "technical" | "editorial" | "interrupted" | null; retry_count?: number; editorial_rounds?: number; resubmit_allowance?: number };
export const SCRIPT_JOB_COLUMNS = "id,topic,status,stage,error_message,request_id,created_at,updated_at,failure_kind,retry_count,editorial_rounds,resubmit_allowance";
/** Labels come only from persisted state. A failed job without a recorded kind
 * predates classification and is treated as technical (retryable). */
export function scriptJobView(job: ScriptJobSummary, now: number) {
 const stalled = job.status === "running" && now-Date.parse(job.updated_at)>600_000;
 const kind = job.status === "failed" ? (job.failure_kind ?? "technical") : null;
 const retries = job.retry_count ?? 0, rounds = job.editorial_rounds ?? 0, resubmits = job.resubmit_allowance ?? 0;
 const action = kind === "editorial" ? (rounds < 2 ? "Pedir otra corrección editorial" : null)
  : kind === "interrupted" ? (retries < 3 && resubmits < 2 ? "Reanudar preparación" : null)
  : kind === "technical" ? (retries < 3 ? "Reintentar (reutiliza lo ya guardado)" : null) : null;
 const label = stalled ? "Interrumpido" : kind === "editorial" ? "Objeción editorial" : kind === "interrupted" ? "Interrumpido" : kind === "technical" ? "Fallo técnico"
  : ({ queued:"En cola", running:"Preparando guion", completed:"Guion listo" }[job.status] ?? "En espera");
 return { label, kind,
   message: stalled ? "La última etapa no confirmó su resultado. Los avances están guardados; al volver a abrir esta página podrás reanudarla." : job.error_message,
   refresh: ["queued","running"].includes(job.status) && !stalled, action };
}
