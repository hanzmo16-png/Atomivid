/**
 * Podcast 3.0 — costos: estimación previa desglosada (voz, avatar, imágenes, video, render), presupuesto máximo por
 * episodio, bloqueo de cargos no autorizados, deduplicación por clave de idempotencia, registro del costo real,
 * reintentos sin doble cobro y liberación de reservas de operaciones fallidas no entregadas.
 * Tarifas: las del código (getPricingConfig, estimateHeygenCost, RECRAFT_USD_PER_IMAGE); Pexels gratis.
 */
import { createHash } from "node:crypto";
import { getPricingConfig } from "@/lib/billing/pricing";
import { estimateHeygenCost } from "@/lib/providers/avatar/heygen";
import { RECRAFT_USD_PER_IMAGE } from "@/lib/providers/image/recraft";
import { ceilLedgerUsd } from "@/lib/supply/anthropic-cost";
import type { EditorialPlan } from "./editorial";

export type CostLine = { concept: "voz" | "avatar" | "imagenes" | "video" | "render"; detail: string; usd: number; provider: string };
export type CostEstimate = { lines: CostLine[]; totalUsd: number; assumptions: string[] };
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

export function estimateEpisodeCost(input: {
  ttsChars: number; plan: EditorialPlan; recreationImages: number; aiVideoSeconds?: number; renderMinutesFactor?: number; episodeSeconds: number;
  avatarCreations?: number; pricing?: ReturnType<typeof getPricingConfig>;
}): CostEstimate {
  const p = input.pricing ?? getPricingConfig();
  const lines: CostLine[] = [];
  const voz = input.ttsChars > 0 ? ceilLedgerUsd(input.ttsChars / 1000 * p.elevenLabsUsdPer1kChars) : 0;
  lines.push({ concept: "voz", detail: `${input.ttsChars.toLocaleString("es-MX")} caracteres a USD ${p.elevenLabsUsdPer1kChars}/1K`, usd: voz, provider: "ElevenLabs" });
  // HeyGen cobra por clip generado (redondeo a centavo por clip): se suma por aparición, no por segundos totales.
  const clips = input.plan.shots.filter((s) => s.kind === "avatar_a" || s.kind === "avatar_b" || s.kind === "two_shot" || s.kind === "over_shoulder");
  let avatar = 0, avatarSecs = 0;
  for (const s of clips) { const d = s.end - s.start; avatar += estimateHeygenCost(Math.max(1, d)); avatarSecs += d; }
  lines.push({ concept: "avatar", detail: `${clips.length} apariciones · ${Math.round(avatarSecs)} s de avatar (HeyGen Avatar IV foto, ~USD 0.0385/s)${input.avatarCreations ? ` · ${input.avatarCreations} avatar(es) nuevos desde foto (sin costo de subida)` : ""}`, usd: r4(avatar), provider: "HeyGen" });
  const imgs = input.plan.shots.filter((s) => s.kind === "imagen" || s.kind === "archivo").length;
  const rec = input.recreationImages * RECRAFT_USD_PER_IMAGE;
  lines.push({ concept: "imagenes", detail: `${imgs} fotos de archivo (Pexels, gratis) · ${input.recreationImages} recreaciones a USD ${RECRAFT_USD_PER_IMAGE}`, usd: r4(rec), provider: "Pexels / Recraft" });
  lines.push({ concept: "video", detail: input.aiVideoSeconds ? `${input.aiVideoSeconds} s de video generativo` : "Sin video generativo (planos compuestos con FFmpeg)", usd: 0, provider: "—" });
  const renderMin = Math.ceil(input.episodeSeconds / 60 * (input.renderMinutesFactor ?? 1.5)) + 3;
  lines.push({ concept: "render", detail: `~${renderMin} min de runner (GitHub Actions) a USD ${p.renderUsdPerMinute}/min`, usd: r4(renderMin * p.renderUsdPerMinute), provider: "GitHub Actions" });
  return { lines, totalUsd: r4(lines.reduce((s, l) => s + l.usd, 0)), assumptions: [
    "Voz: tarifa de PRICING_ELEVENLABS_USD_PER_1K_CHARS (o 0,10 por defecto).",
    "Avatar: tarifa observada de HeyGen Avatar IV con foto (estimateHeygenCost), un clip por aparición (en two-shot/sobre el hombro solo habla uno; el otro es un fotograma fijo, sin costo).",
    "Imágenes: Pexels sin costo; recreaciones con Recraft solo si se activan.",
    "Render: duración × 1,5 + 3 min de preparación; minutos gratuitos de Actions no descontados.",
  ] };
}

/** Clave de idempotencia por operación de proveedor: misma entrada → misma clave (dedupe y caché). */
export function opKey(parts: { owner: string; episode: string; provider: string; op: string; payload: unknown }): string {
  return createHash("sha256").update(JSON.stringify([parts.owner, parts.episode, parts.provider, parts.op, parts.payload])).digest("hex");
}

export type LedgerState = "reserved" | "settled" | "released" | "uncertain";
export type LedgerRow = { key: string; owner: string; episode: string; provider: string; op: string; state: LedgerState; reserved_usd: number; actual_usd: number | null; result?: string };
export interface StudioLedger { get(key: string): Promise<LedgerRow | undefined>; put(row: LedgerRow): Promise<void>; byEpisode(episode: string): Promise<LedgerRow[]> }

export class MemoryLedger implements StudioLedger {
  rows = new Map<string, LedgerRow>();
  async get(k: string) { const r = this.rows.get(k); return r ? { ...r } : undefined; }
  async put(r: LedgerRow) { this.rows.set(r.key, { ...r }); }
  async byEpisode(e: string) { return [...this.rows.values()].filter((r) => r.episode === e).map((r) => ({ ...r })); }
}

export class BudgetExceededError extends Error { constructor(public needed: number, public remaining: number) { super(`Presupuesto del episodio insuficiente: se necesitan USD ${needed.toFixed(4)} y quedan USD ${remaining.toFixed(4)}. No se hizo ningún cargo.`); this.name = "BudgetExceededError"; } }
export class UnauthorizedChargeError extends Error { constructor() { super("La generación no está autorizada: confirma el costo estimado antes de generar."); this.name = "UnauthorizedChargeError"; } }
export class UncertainChargeError extends Error { constructor(key: string) { super(`Cobro incierto pendiente de conciliar (${key.slice(0, 12)}…): no se reintenta para no cobrar dos veces.`); this.name = "UncertainChargeError"; } }
/** Error del proveedor del que se SABE que no hubo cargo (rechazo antes de aceptar el trabajo): la reserva se libera. */
export class ProviderRejectedError extends Error { constructor(m: string) { super(m); this.name = "ProviderRejectedError"; } }

/** Comprometido = reservado + liquidado + incierto (lo liberado no cuenta). */
export async function committedUsd(ledger: StudioLedger, episode: string): Promise<number> {
  return r4((await ledger.byEpisode(episode)).reduce((s, r) => s + (r.state === "released" ? 0 : r.state === "settled" ? (r.actual_usd ?? r.reserved_usd) : r.reserved_usd), 0));
}

/**
 * Ejecuta una operación de pago UNA vez por clave:
 *  - liquidada → devuelve el resultado guardado (reintento sin cobro);
 *  - reservada/incierta → bloquea (no se repite un cargo dudoso);
 *  - liberada (falló sin cargo) → puede reintentarse;
 *  - sin autorización o sin presupuesto → no llama al proveedor.
 */
export async function paidOnce<T extends { result: string; actualUsd: number }>(ledger: StudioLedger, req: { key: string; owner: string; episode: string; provider: string; op: string; usd: number; budgetUsd: number; authorized: boolean }, call: () => Promise<T>): Promise<{ result: string; reused: boolean; usd: number }> {
  if (!req.authorized) throw new UnauthorizedChargeError();
  const prev = await ledger.get(req.key);
  if (prev && prev.owner !== req.owner) throw new Error("ACCESO_DENEGADO");
  if (prev?.state === "settled" && prev.result) return { result: prev.result, reused: true, usd: 0 };
  if (prev && (prev.state === "reserved" || prev.state === "uncertain")) throw new UncertainChargeError(req.key);
  const remaining = r4(req.budgetUsd - await committedUsd(ledger, req.episode));
  if (req.usd > remaining + 1e-9) throw new BudgetExceededError(req.usd, remaining);
  const base = { key: req.key, owner: req.owner, episode: req.episode, provider: req.provider, op: req.op, reserved_usd: req.usd };
  await ledger.put({ ...base, state: "reserved", actual_usd: null });
  try {
    const out = await call();
    await ledger.put({ ...base, state: "settled", actual_usd: out.actualUsd, result: out.result });
    return { result: out.result, reused: false, usd: out.actualUsd };
  } catch (e) {
    // Rechazo previo a la aceptación del trabajo → sin cargo: se libera. Cualquier otro error → incierto (se concilia).
    await ledger.put({ ...base, state: e instanceof ProviderRejectedError ? "released" : "uncertain", actual_usd: e instanceof ProviderRejectedError ? 0 : null });
    throw e;
  }
}

/** Al fallar la entrega del episodio: lo reservado y no liquidado se libera; lo liquidado queda como gasto real del proveedor. */
export async function releaseUndelivered(ledger: StudioLedger, episode: string): Promise<number> {
  let n = 0;
  for (const r of await ledger.byEpisode(episode)) if (r.state === "reserved") { await ledger.put({ ...r, state: "released", actual_usd: 0 }); n++; }
  return n;
}
