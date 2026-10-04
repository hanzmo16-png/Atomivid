import { z } from "zod";
import { stableHash } from "@/lib/production-intelligence/canonical";
import type { SupabaseClient } from "@supabase/supabase-js";

/** A service-only, expiring grant for one measured request. Never a Stripe subscription. */
export const OwnerPilotSchema = z.object({
  version: z.literal("owner-pilot/1"), ownerId: z.string().uuid(), requestId: z.string().uuid(),
  expiresAt: z.string().datetime(), scriptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  maxDurationSeconds: z.literal(30), maxRenderAttempts: z.literal(1),
  budgetVerified: z.literal(true), maxVoiceCalls: z.literal(2),
  maxVoiceCharacters: z.number().int().positive().max(1000),
  billingBasis: z.literal("prepaid_no_overage"),
  voiceUsdPer1kChars: z.literal(0),
  maxProviderUsd: z.literal(0),
  voiceId: z.string().min(1), modelId: z.literal("eleven_multilingual_v2"),
  quoteEvidence: z.string().min(1),
}).strict();
export type OwnerPilot = z.infer<typeof OwnerPilotSchema>;
export const ownerPilotKey = (requestId: string) => `owner_pilot_grant:${requestId}`;
export async function readOwnerPilot(service: SupabaseClient, requestId: string): Promise<OwnerPilot | null> {
  const { data, error } = await service.from("pi_paid_operations")
    .select("result_ref,method,status,project_id,provider,reserved_usd,committed_usd")
    .eq("idempotency_key", ownerPilotKey(requestId)).maybeSingle();
  if (error) throw new Error("PILOT_GRANT_UNAVAILABLE");
  if (!data) return null;
  if (data.method !== "human_direction" || data.status !== "COMMITTED" || data.project_id !== requestId || data.provider !== "internal"
    || Number(data.reserved_usd) !== 0 || Number(data.committed_usd) !== 0) throw new Error("PILOT_GRANT_INVALID");
  const grant = OwnerPilotSchema.parse(JSON.parse(data.result_ref));
  if (grant.requestId !== requestId) throw new Error("PILOT_GRANT_INVALID");
  return grant;
}
export type PilotRequest = { id: string; user_id: string; mode: string | null | undefined; duration_seconds: number | null;
  script_json: unknown; render_attempts: number };
export function assertOwnerPilot(grant: OwnerPilot, row: PilotRequest,
  user: { id: string; email_confirmed_at?: string }, phase: "admission" | "worker", now = Date.now()) {
  const script = z.object({ segments: z.array(z.object({ text: z.string() })).min(1) }).safeParse(row.script_json);
  if (!user.email_confirmed_at || user.id !== grant.ownerId || row.user_id !== grant.ownerId || row.id !== grant.requestId
    || now >= Date.parse(grant.expiresAt) || row.mode !== "visual" || !row.duration_seconds
    || row.duration_seconds > grant.maxDurationSeconds || !row.script_json
    || stableHash(row.script_json, 64) !== grant.scriptSha256
    || !script.success || script.data.segments.map(s => s.text).join(" ").length > grant.maxVoiceCharacters
    || !Number.isInteger(row.render_attempts) || row.render_attempts < 0
    || (phase === "admission" ? row.render_attempts !== 0 : row.render_attempts !== 1)) throw new Error("PILOT_SCOPE_BLOCKED");
}
