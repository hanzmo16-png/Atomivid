import { z } from "zod";
import type { CreativeHistoryEntry } from "./creative-direction";
export const ScriptJobFieldsSchema = z.object({
 topic: z.string().trim().min(3).max(200),
 durationMinutes: z.string().refine(v => Number.isFinite(Number(v)) && Number(v)>=3 && Number(v)<=15),
 sources: z.string().max(12000), openQuestions: z.string().max(4000), language: z.enum(["en","es"]),
});
export type ScriptJobFields = z.infer<typeof ScriptJobFieldsSchema>;
export type ScriptJobInput = { fields: ScriptJobFields; creativeHistory: CreativeHistoryEntry[]; recoverLegacyOperator: boolean };
export type ScriptJobSummary = { id: string; topic: string; status: string; stage: string; error_message: string | null; request_id: string; created_at: string; updated_at: string };
export function scriptJobView(job: ScriptJobSummary, now: number) {
 const stalled = job.status === "running" && now-Date.parse(job.updated_at)>360_000;
 return { label: stalled ? "Necesita revisión" : ({ queued:"En cola", running:"Preparando guion", failed:"Preparación detenida", completed:"Guion listo" }[job.status] ?? "En espera"),
   message: stalled ? "La última etapa no confirmó su resultado. Los avances están guardados; no repetimos llamadas de resultado incierto." : job.error_message,
   refresh: ["queued","running"].includes(job.status) && !stalled };
}
