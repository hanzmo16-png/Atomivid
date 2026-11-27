import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { requireCommandCenterAdmin, type AuthUser } from "./access";
import { billingAccountKey } from "../supply/billing-account";

export type SupplyAlert = { id: string; provider: string; level: "RED" | "YELLOW" | "UNKNOWN"; createdAt: string | null; message: string; action: string; occurrencesInSample?: number };
export type SupplyInbox = { available: boolean; alerts: SupplyAlert[] };

const names: Record<string, string> = { fal: "fal.ai (FLUX / Recraft)", elevenlabs: "ElevenLabs", runway: "Runway", heygen: "HeyGen", openai: "OpenAI", anthropic: "Anthropic", veo: "Veo", gemini: "Gemini", __global__: "Monitor de créditos" };
export function presentSupplyAlert(row: Record<string, unknown>): SupplyAlert {
  const payload = row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
  const level = row.level === "RED" || row.level === "YELLOW" ? row.level : "UNKNOWN";
  const startup = payload.reason === "monitor_job_did_not_start";
  const low = payload.reason === "reported_wallet_low";
  const createdAt = typeof row.created_at === "string" && Number.isFinite(Date.parse(row.created_at)) ? row.created_at : null;
  return {
    id: String(row.id), provider: names[billingAccountKey(String(row.provider))] ?? "Proveedor", level, createdAt,
    message: startup ? "La consulta del monitor no llegó a iniciarse." : low ? "El saldo observado alcanzó el umbral de aviso." : "No se pudo verificar el saldo o la capacidad.",
    action: low ? "Revisa el saldo actual del proveedor y considera una recarga antes de producir." : "Revisa la última consulta del monitor antes de planificar nuevas producciones.",
  };
}

/** Owner/admin gate precedes every privileged read. Read-only; no delivery or acknowledgement. */
export async function loadSupplyInbox(user: AuthUser, client: SupabaseClient, env: Record<string, string | undefined> = process.env): Promise<SupplyInbox> {
  requireCommandCenterAdmin(user, env);
  try {
    const { data, error } = await client.from("pi_supply_alerts").select("id,provider,level,payload,created_at").order("created_at", { ascending: false }).limit(1000);
    // At the bound the unseen history may contain more occurrences/incidents: never claim completeness.
    if (error || !Array.isArray(data) || data.length >= 1000) return { available: false, alerts: [] };
    const incidents = new Map<string, SupplyAlert>();
    for (const row of data) {
      const alert = presentSupplyAlert(row);
      // Distinct upstream causes must not collapse just because the safe public
      // message is generic. Hash the cause for internal equality only; never export it.
      const reason = row.payload && typeof row.payload === "object" && typeof row.payload.reason === "string" ? row.payload.reason : "UNSPECIFIED_REASON";
      const cause = createHash("sha256").update(reason).digest("hex");
      const key = JSON.stringify([billingAccountKey(String(row.provider)), alert.level, cause, alert.message, alert.action]);
      const previous = incidents.get(key);
      const latest = !previous || Date.parse(alert.createdAt ?? "") > Date.parse(previous.createdAt ?? "") || (alert.createdAt !== null && previous.createdAt === null) ? alert : previous;
      incidents.set(key, { ...latest, occurrencesInSample: (previous?.occurrencesInSample ?? 0) + 1 });
    }
    return { available: true, alerts: [...incidents.values()].sort((a,b) => (b.createdAt ? Date.parse(b.createdAt) : -Infinity) - (a.createdAt ? Date.parse(a.createdAt) : -Infinity)).slice(0,20) };
  } catch { return { available: false, alerts: [] }; }
}
