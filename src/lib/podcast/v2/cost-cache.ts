/** Podcast 2.0 — Estimación de costo previa, caché por hash de contenido e idempotencia (sin red). */
import { createHash } from "node:crypto";
import { ceilLedgerUsd } from "@/lib/supply/anthropic-cost";

/** Precios publicados (USD/1K caracteres) — https://elevenlabs.io/pricing/api (consultado 2026-10-21). Desconocido → error. */
export const TTS_USD_PER_1K: Record<string, number> = { eleven_multilingual_v2: 0.08, eleven_v3: 0.08, eleven_v4: 0.08, eleven_flash_v2_5: 0.04, eleven_flash_v2: 0.04 };

export class UnknownPriceError extends Error { constructor(m: string) { super(`Precio desconocido para ${m}: no se reserva ni se llama (fail-safe).`); } }

export function segmentKey(s: { owner_id: string; voice_id: string; model: string; text: string; settings: unknown }): string {
  return createHash("sha256").update(JSON.stringify([s.owner_id, s.voice_id, s.model, s.text, s.settings])).digest("hex");
}

export function estimateCall(model: string, chars: number, overrideRate?: number): number {
  const rate = overrideRate ?? TTS_USD_PER_1K[model];
  if (rate === undefined || !Number.isFinite(rate)) throw new UnknownPriceError(model);
  return ceilLedgerUsd(chars / 1000 * rate);
}

export type CacheEntry = { key: string; owner_id: string; state: "reserved" | "paid" | "ambiguous" | "failed_unbilled"; usd: number; file?: string };
export interface DurableStore { get(k: string): CacheEntry | undefined; put(e: CacheEntry): void; all(): CacheEntry[] }

export class MemoryStore implements DurableStore {
  private m = new Map<string, CacheEntry>();
  constructor(seed: CacheEntry[] = []) { for (const e of seed) this.m.set(e.key, e); }
  get(k: string) { return this.m.get(k); } put(e: CacheEntry) { this.m.set(e.key, { ...e }); } all() { return [...this.m.values()]; }
}

/** Presupuesto acumulado: reservado, pagado y AMBIGUO cuentan como gastado. */
export function spent(store: DurableStore, owner: string): number {
  return store.all().filter(e => e.owner_id === owner && e.state !== "failed_unbilled").reduce((s, e) => s + e.usd, 0);
}

export type SynthFn = (key: string) => Promise<{ file: string }>;

/** Sintetiza una vez por clave. Reintento/timeout/refresh nunca duplica gasto: «ambiguous» bloquea hasta reconciliar. */
export async function synthOnce(store: DurableStore, req: { key: string; owner_id: string; usd: number; capUsd: number }, synth: SynthFn): Promise<{ file: string; reused: boolean }> {
  const prev = store.get(req.key);
  if (prev && prev.owner_id !== req.owner_id) throw new Error("ACCESO_DENEGADO: el segmento pertenece a otra cuenta");
  if (prev?.state === "paid" && prev.file) return { file: prev.file, reused: true };
  if (prev && (prev.state === "reserved" || prev.state === "ambiguous")) throw new Error("SEGMENTO_INCIERTO: reconciliar antes de reintentar; no se vuelve a pagar");
  if (spent(store, req.owner_id) + req.usd > req.capUsd + 1e-9) throw new Error("PRESUPUESTO_AGOTADO");
  store.put({ key: req.key, owner_id: req.owner_id, state: "reserved", usd: req.usd });
  try {
    const r = await synth(req.key);
    store.put({ key: req.key, owner_id: req.owner_id, state: "paid", usd: req.usd, file: r.file });
    return { file: r.file, reused: false };
  } catch (e) {
    store.put({ key: req.key, owner_id: req.owner_id, state: "ambiguous", usd: req.usd });
    throw e;
  }
}
