import type { SupabaseClient } from "@supabase/supabase-js";
import { requireCommandCenterAdmin, type AuthUser } from "./access";

export type SupplyAlert = { id: string; provider: string; level: "RED" | "YELLOW" | "UNKNOWN"; createdAt: string | null; message: string; action: string };
export type SupplyInbox = { available: boolean; alerts: SupplyAlert[] };

const names: Record<string, string> = { elevenlabs: "ElevenLabs", runway: "Runway", heygen: "HeyGen", openai: "OpenAI", anthropic: "Anthropic", veo: "Veo", gemini: "Gemini", __global__: "Monitor de créditos" };
export function presentSupplyAlert(row: Record<string, unknown>): SupplyAlert {
  const payload = row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
  const level = row.level === "RED" || row.level === "YELLOW" ? row.level : "UNKNOWN";
  const startup = payload.reason === "monitor_job_did_not_start";
  const low = payload.reason === "reported_wallet_low";
  const createdAt = typeof row.created_at === "string" && Number.isFinite(Date.parse(row.created_at)) ? row.created_at : null;
  return {
    id: String(row.id), provider: names[String(row.provider)] ?? "Proveedor", level, createdAt,
    message: startup ? "La consulta del monitor no llegó a iniciarse." : low ? "El saldo observado alcanzó el umbral de aviso." : "No se pudo verificar el saldo o la capacidad.",
    action: low ? "Revisa el saldo actual del proveedor y considera una recarga antes de producir." : "Revisa la última consulta del monitor antes de planificar nuevas producciones.",
  };
}

/** Owner/admin gate precedes every privileged read. Read-only; no delivery or acknowledgement. */
export async function loadSupplyInbox(user: AuthUser, client: SupabaseClient, env: Record<string, string | undefined> = process.env): Promise<SupplyInbox> {
  requireCommandCenterAdmin(user, env);
  try {
    const { data, error } = await client.from("pi_supply_alerts").select("id,provider,level,payload,created_at").order("created_at", { ascending: false }).limit(20);
    if (error || !Array.isArray(data)) return { available: false, alerts: [] };
    return { available: true, alerts: data.map(presentSupplyAlert) };
  } catch { return { available: false, alerts: [] }; }
}
