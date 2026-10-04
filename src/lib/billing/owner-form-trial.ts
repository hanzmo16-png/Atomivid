import { z } from "zod";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { GeneratedScript } from "@/lib/providers/types";
import { stableHash } from "@/lib/production-intelligence/canonical";
import { visualPlanIssue } from "@/lib/video/visual-intent";
import { supabaseLedgerStore } from "@/lib/paid-calls/supabase-ledger-store";

export const OwnerFormTrialSchema = z.object({
  version: z.literal("owner-form-trial/1"), ownerId: z.string().uuid(), requestId: z.string().uuid(),
  expiresAt: z.string().datetime(), topic: z.string().min(1).max(1000), style: z.string().min(1).max(100),
  language: z.literal("es"), durationSeconds: z.literal(30),
  maxAccountedUsd: z.literal(1.25), maxScriptCalls: z.literal(3), scriptReservationUsd: z.literal(0.15),
  scriptModel: z.literal("claude-sonnet-5"), maxVoiceCalls: z.literal(2), maxVoiceCharacters: z.literal(1000),
  voiceId: z.string().min(1), voiceModel: z.literal("eleven_multilingual_v2"),
  maxImages: z.literal(6), maxImageReservationUsd: z.literal(0.08), maxReviews: z.literal(20),
  maxRenderAttempts: z.literal(1), authorization: z.literal("2026-10-04:owner-authorized-form-test"),
}).strict();
export type OwnerFormTrial = z.infer<typeof OwnerFormTrialSchema>;
export const ownerFormTrialKey = (id: string) => `owner_form_trial:${id}`;
export const ownerFormRenderKey = (id: string) => `owner_form_render:${id}`;
type TrialRow = { id: string; user_id: string; mode: string; topic: string | null; style: string | null;
  language?: string | null; duration_seconds: number | null; status: string; render_attempts?: number; script_json: GeneratedScript | null };

export async function readOwnerFormTrial(service: SupabaseClient, id: string): Promise<OwnerFormTrial | null> {
  const receipt = await supabaseLedgerStore(service).get(ownerFormTrialKey(id));
  if (!receipt) return null;
  if (receipt.projectId !== id || receipt.provider !== "internal" || receipt.method !== "human_direction"
    || receipt.status !== "COMMITTED" || receipt.reservedUsd !== 0 || receipt.committedUsd !== 0 || !receipt.resultRef)
    throw new Error("OWNER_FORM_TRIAL_INVALID_RECEIPT");
  const grant = OwnerFormTrialSchema.parse(JSON.parse(receipt.resultRef));
  if (grant.requestId !== id) throw new Error("OWNER_FORM_TRIAL_REQUEST_MISMATCH");
  return grant;
}

export function assertOwnerFormTrial(grant: OwnerFormTrial, row: TrialRow, user: Pick<User, "id" | "email_confirmed_at">,
  phase: "script" | "admission" | "worker", now = Date.now()) {
  if (!user.email_confirmed_at || user.id !== grant.ownerId || row.user_id !== grant.ownerId || row.id !== grant.requestId
    || Date.parse(grant.expiresAt) <= now || row.mode !== "visual" || row.duration_seconds !== grant.durationSeconds
    || row.topic !== grant.topic || row.style !== grant.style || row.language !== grant.language)
    throw new Error("Este permiso de prueba expiró o no corresponde a esta solicitud.");
  if (phase === "script") {
    if (!["pending", "failed", "script_ready"].includes(row.status) || row.render_attempts !== 0)
      throw new Error("La prueba ya pasó a producción; no se volverá a generar el guion.");
    return;
  }
  const script = row.script_json;
  if (!script || script.segments.length > grant.maxImages || visualPlanIssue(script.segments)
    || script.segments.map(s => s.text).join(" ").length > grant.maxVoiceCharacters
    || row.render_attempts !== (phase === "worker" ? 1 : 0)
    || row.status !== (phase === "worker" ? "processing" : "script_ready"))
    throw new Error("El guion o el intento está fuera del permiso de prueba.");
}

/** Freeze the reviewed server script. A concurrent edit is refused again by the worker. */
export async function freezeOwnerFormRender(service: SupabaseClient, grant: OwnerFormTrial, script: GeneratedScript) {
  const store = supabaseLedgerStore(service), key = ownerFormRenderKey(grant.requestId);
  const hash = stableHash(script, 64);
  const prior = await store.get(key);
  if (prior) {
    if (prior.status !== "COMMITTED" || prior.provider !== "internal" || prior.method !== "freeze_reviewed_script"
      || prior.projectId !== grant.requestId || prior.resultRef !== hash) throw new Error("El guion cambió después de confirmar la prueba.");
    return;
  }
  const inserted = await store.insert({ idempotencyKey: key, projectId: grant.requestId, shotId: "owner-form-render",
    provider: "internal", model: "owner-form-trial/1", method: "freeze_reviewed_script", attemptKind: "initial",
    reservedUsd: 0, committedUsd: 0, status: "COMMITTED", providerJobId: null, resultRef: hash, updatedAt: new Date().toISOString() });
  if (!inserted) await freezeOwnerFormRender(service, grant, script);
}

export async function assertOwnerFormFrozen(service: SupabaseClient, grant: OwnerFormTrial, script: GeneratedScript) {
  const row = await supabaseLedgerStore(service).get(ownerFormRenderKey(grant.requestId));
  if (!row || row.status !== "COMMITTED" || row.provider !== "internal" || row.method !== "freeze_reviewed_script"
    || row.projectId !== grant.requestId || row.resultRef !== stableHash(script, 64)) throw new Error("OWNER_FORM_TRIAL_SCRIPT_CHANGED");
}
