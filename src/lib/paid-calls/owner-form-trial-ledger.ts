import type { SupabaseClient } from "@supabase/supabase-js";
import type { OwnerFormTrial } from "@/lib/billing/owner-form-trial";
import type { LedgerStore } from "./gate";
import { supabaseLedgerStore } from "./supabase-ledger-store";

/** The service-only RPC locks the whole request, including vision and uncertain calls. */
export function ownerFormTrialLedger(service: SupabaseClient, grant: OwnerFormTrial): LedgerStore {
  const base = supabaseLedgerStore(service);
  return { ...base, async insert(op) {
    if (op.projectId !== grant.requestId || !Number.isFinite(op.reservedUsd) || op.reservedUsd <= 0)
      throw new Error("OWNER_FORM_TRIAL_PAID_SCOPE_BLOCKED");
    const { data, error } = await service.rpc("reserve_owner_form_trial_operation", {
      p_key: op.idempotencyKey, p_request_id: op.projectId, p_shot: op.shotId,
      p_provider: op.provider, p_model: op.model, p_method: op.method,
      p_attempt_kind: op.attemptKind, p_reserved_usd: op.reservedUsd,
    });
    if (error || typeof data !== "boolean") throw new Error("Se alcanzó el límite del permiso de prueba o no se pudo verificar su presupuesto.");
    return data;
  } };
}
