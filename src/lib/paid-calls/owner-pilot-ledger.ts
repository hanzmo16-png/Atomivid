import type { SupabaseClient } from "@supabase/supabase-js";
import type { OwnerPilot } from "@/lib/billing/owner-pilot";
import type { LedgerStore } from "./gate";
import { supabaseLedgerStore } from "./supabase-ledger-store";

/** The RPC holds a project lock and reserves against the private quote atomically. */
export function ownerPilotLedger(service: SupabaseClient, grant: OwnerPilot): LedgerStore {
  const store = supabaseLedgerStore(service);
  return { ...store, async insert(op) {
    if (op.projectId !== grant.requestId || op.provider !== "elevenlabs" || op.model !== grant.modelId
      || op.method !== "tts_with_timestamps" || !Number.isFinite(op.reservedUsd) || op.reservedUsd !== 0
      || op.reservedUsd > grant.maxVoiceCharacters / 1000 * grant.voiceUsdPer1kChars + 1e-9) throw new Error("PILOT_PAID_CALL_BLOCKED");
    const { data, error } = await service.rpc("reserve_owner_pilot_operation", {
      p_key: op.idempotencyKey, p_request_id: op.projectId, p_shot: op.shotId,
      p_provider: op.provider, p_model: op.model, p_method: op.method,
      p_attempt_kind: op.attemptKind, p_reserved_usd: op.reservedUsd,
    });
    if (error || typeof data !== "boolean") throw new Error("PILOT_BUDGET_BLOCKED");
    return data;
  } };
}
