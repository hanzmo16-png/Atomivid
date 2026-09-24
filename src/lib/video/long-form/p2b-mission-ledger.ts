/**
 * P2B — ledger DURABLE de gasto de la misión "cerrar AI Video Veo
 * end-to-end" (presupuesto total autorizado por Hans: $10 USD, no por
 * intento — ver comentario de cabecera de p2b-pillar-transport-execution.ts).
 *
 * Se persiste en el MISMO bucket Supabase Storage que ya usa el resto de
 * Long Form (`AI_VIDEO_STORAGE_BUCKET`, ver ai-video-storage.ts) — nunca
 * infraestructura nueva. Es DURABLE a propósito: cada invocación de la ruta
 * administrativa en Vercel corre en un proceso/contenedor efímero distinto,
 * así que el techo de $10 acumulado solo puede verificarse leyendo un
 * registro que sobreviva entre invocaciones — igual que
 * ai-video-storage.ts ya hace para idempotencia de clips.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { AI_VIDEO_STORAGE_BUCKET } from "./ai-video-storage";

/** Techo TOTAL autorizado por Hans para toda la misión (no por generación) — nunca configurable por env var. */
export const MISSION_TOTAL_BUDGET_USD = 10.0;
/** Techo por clip individual — sigue vigente además del techo total (sanity check de que el precio no cambió). */
export const PER_CLIP_MAX_COST_USD = 1.0;

export const LEDGER_STORAGE_PATH = "long-form/gobekli-tepe-ai-video-benchmark-v2-active/state/p2b-mission-ledger.json";

export type P2BLedgerEntryResult = "success" | "failure" | "preflight_blocked";

export type P2BLedgerEntry = {
  attempt: number;
  timestampIso: string;
  provider: string;
  model: string;
  shotId: string;
  reason: string;
  expectedCostUsd: number;
  /** null cuando no se pudo confirmar (fallo antes/durante la llamada) — para el ledger se asume expectedCostUsd como gasto conservador, ver cumulativeBillableSpend. */
  actualCostUsd: number | null;
  result: P2BLedgerEntryResult;
  providerJobId?: string;
  errorReason?: string;
};

export type P2BLedger = { entries: P2BLedgerEntry[] };

/**
 * Gasto acumulado "facturable" — cualquier intento que pasó de nuestros
 * propios preflight checks y llegó a intentar llamar a Google
 * (`result !== "preflight_blocked"`) cuenta como gastado, usando
 * `actualCostUsd` si se confirmó o `expectedCostUsd` como estimación
 * conservadora si el intento falló a medio camino (Google pudo haber
 * facturado la operación aunque la descarga/validación fallara después) —
 * nunca se subestima el gasto para no arriesgar superar el techo real.
 */
export function cumulativeBillableSpend(ledger: P2BLedger): number {
  return ledger.entries
    .filter((entry) => entry.result !== "preflight_blocked")
    .reduce((sum, entry) => sum + (entry.actualCostUsd ?? entry.expectedCostUsd), 0);
}

export async function readLedger(supabase: SupabaseClient): Promise<P2BLedger> {
  const { data, error } = await supabase.storage.from(AI_VIDEO_STORAGE_BUCKET).download(LEDGER_STORAGE_PATH);
  if (error || !data) return { entries: [] };
  const text = await data.text();
  if (!text) return { entries: [] };
  try {
    const parsed = JSON.parse(text) as P2BLedger;
    return Array.isArray(parsed?.entries) ? parsed : { entries: [] };
  } catch {
    return { entries: [] };
  }
}

export async function appendLedgerEntry(supabase: SupabaseClient, entry: P2BLedgerEntry): Promise<P2BLedger> {
  const current = await readLedger(supabase);
  const next: P2BLedger = { entries: [...current.entries, entry] };
  const body = Buffer.from(JSON.stringify(next, null, 2));
  const { error } = await supabase.storage
    .from(AI_VIDEO_STORAGE_BUCKET)
    .upload(LEDGER_STORAGE_PATH, body, { contentType: "application/json", upsert: true });
  if (error) throw new Error(`No se pudo guardar el ledger de la misión P2B: ${error.message}`);
  return next;
}

/** Pura — evalúa si un intento planeado de `plannedCostUsd` cabe bajo el techo TOTAL de la misión, dado el ledger actual. Nunca decide sobre el techo POR CLIP (eso lo sigue validando p2b-pillar-transport-execution.ts por separado). */
export function evaluateMissionBudget(ledger: P2BLedger, plannedCostUsd: number): { allowed: true } | { allowed: false; detail: string } {
  const spent = cumulativeBillableSpend(ledger);
  const projected = spent + plannedCostUsd;
  if (projected >= MISSION_TOTAL_BUDGET_USD) {
    return {
      allowed: false,
      detail: `Gasto acumulado de la misión ($${spent.toFixed(2)}) + este intento ($${plannedCostUsd.toFixed(2)}) = $${projected.toFixed(2)}, que alcanza o supera el techo total autorizado ($${MISSION_TOTAL_BUDGET_USD.toFixed(2)}).`,
    };
  }
  return { allowed: true };
}
