/**
 * Podcast 3.0 — lógica de las rutas /api/podcast/v3 separada de Next (probada con dependencias simuladas).
 * Nada aquí llama a proveedores de pago: crear y estimar son gratis; autorizar solo registra el monto aprobado y
 * despacha el trabajo (la generación ocurre en el worker con el libro de operaciones).
 */
import type { AccountVoice } from "@/lib/podcast/voices";
import type { VoiceViewer } from "@/lib/voices/private-voices";
import { StudioSpec, validateSpec, STUDIO_VERSION, type StudioSpec as Spec } from "./spec";
import { preflight, type ImageProvider, type Providers } from "./pipeline";
import { generateConversation, type LlmFn } from "./script";
import { keywords, type VisualAsset } from "./editorial";
import { estimateHeygenCost } from "@/lib/providers/avatar/heygen";
import { getPricingConfig } from "@/lib/billing/pricing";
import type { StudioEpisodeRow } from "./store";
import { requireProvider, ProviderUnavailableError, visualProviders, lipTimeline, shotCoverage } from "./studio";

/** Proveedores de PLANIFICACIÓN (sin red, sin costo): solo para estimar; nunca generan medios. */
export function planningProviders(): Providers {
  const rate = getPricingConfig().elevenLabsUsdPer1kChars;
  const images: ImageProvider = { name: "plan", label: "mock", async search(q) { return [{ id: `plan-${q}`, query: q, kind: "foto", tags: keywords(q) } satisfies VisualAsset]; }, async fetch() { throw new Error("solo planificación"); } };
  return { images,
    tts: { name: "plan", label: "mock", model: "eleven_multilingual_v2", usdFor: (n) => Math.ceil(n / 1000 * rate * 1e4) / 1e4, async synth() { throw new Error("solo planificación"); } },
    avatar: { name: "plan", label: "mock", usdFor: (s) => estimateHeygenCost(Math.max(1, s)), async render() { throw new Error("solo planificación"); }, async still() { throw new Error("solo planificación"); } } };
}

export type ApiDeps = {
  userId: string; viewer: VoiceViewer; voices: () => Promise<AccountVoice[]>; enabled: boolean; llm: LlmFn | null;
  insert: (row: Record<string, unknown>) => Promise<{ id: string } | "missing" | null>;
  load: (id: string) => Promise<StudioEpisodeRow | "missing" | null>;
  /** CAS draft→authorized (devuelve true si cambió exactamente una fila). */
  authorize: (id: string, usd: number) => Promise<boolean>;
  dispatch: (id: string) => Promise<boolean>;
  /** El avatar existente pertenece al usuario y está listo (aislamiento por usuario). */
  ownsAvatar?: (avatarId: string) => Promise<boolean>;
  env?: Record<string, string | undefined>;
};
type Out = { status: number; body: Record<string, unknown> };
const DISABLED: Out = { status: 503, body: { error: "Los modos de estudio (avatar y conversación) se activan tras autorizar la migración y PODCAST_V3_ENABLED. La narración sigue disponible." } };

export async function studioAction(d: ApiDeps, body: Record<string, unknown> | null): Promise<Out> {
  const b = body ?? {};
  if (b.action === "script") {
    const topic = String(b.topic ?? "").trim().slice(0, 500);
    if (topic.length < 3) return { status: 400, body: { error: "Escribe un tema de al menos 3 caracteres." } };
    const minutes = Math.min(30, Math.max(1, Number(b.minutes) || 5));
    const host = String(b.hostName ?? "Anfitrión").slice(0, 60) || "Anfitrión", guest = String(b.guestName ?? "Invitado").slice(0, 60) || "Invitado";
    const r = await generateConversation({ topic, hostName: host, guestName: guest, guestRole: String(b.guestRole ?? "").slice(0, 120), minutes, hostPersonality: String(b.hostPersonality ?? "").slice(0, 160), guestPersonality: String(b.guestPersonality ?? "").slice(0, 160) }, b.useAi === true ? d.llm : null);
    const names = { A: host, B: guest };
    return { status: 200, body: { script: r.turns.map((t) => `${names[t.speaker]}: ${t.text}`).join("\n"), source: r.source, note: r.note ?? null, turns: r.turns.length } };
  }
  const parsed = StudioSpec.safeParse({ ...((b.spec as object) ?? {}), version: STUDIO_VERSION });
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Datos inválidos.", path: parsed.error.issues[0]?.path } };
  const spec: Spec = parsed.data;
  // Proveedor visual elegido: si no está disponible se rechaza con el motivo; nunca se sustituye en silencio.
  try { requireProvider(spec.visual.provider, d.env ?? process.env); } catch (e) { if (e instanceof ProviderUnavailableError) return { status: 409, body: { error: e.message, provider: spec.visual.provider } }; throw e; }
  let voices: AccountVoice[];
  try { voices = await d.voices(); } catch { return { status: 503, body: { error: "No se pudieron consultar las voces; inténtalo más tarde." } }; }
  const issues = validateSpec(spec, voices, d.viewer);
  if (issues.length) return { status: 400, body: { error: issues[0].message, issues } };
  for (const p of spec.participants) {
    if (p.avatar.kind === "foto" && !p.avatar.photo_path.startsWith(`${d.userId}/podcast-studio/photos/`)) return { status: 403, body: { error: "La foto del avatar no pertenece a tu cuenta." } };
    if (p.avatar.kind === "existente" && d.ownsAvatar && !(await d.ownsAvatar(p.avatar.avatar_id))) return { status: 403, body: { error: "Ese avatar no está disponible en tu cuenta." } };
  }
  const pf = await preflight(spec, planningProviders());
  const estimate = { lines: pf.estimate.lines, totalUsd: pf.estimate.totalUsd, assumptions: pf.estimate.assumptions, turns: pf.turns.length, mood: pf.mood,
    shots: pf.plan.shots.reduce<Record<string, number>>((m, s) => ({ ...m, [s.kind]: (m[s.kind] ?? 0) + 1 }), {}), overBudget: pf.estimate.totalUsd > spec.budget_usd,
    byProvider: pf.estimate.lines.reduce<Record<string, number>>((m, l) => ({ ...m, [l.provider]: Math.round(((m[l.provider] ?? 0) + l.usd) * 1e4) / 1e4 }), {}),
    providers: visualProviders(d.env ?? process.env), lipTimeline: lipTimeline(pf.plan).slice(0, 40), coverage: shotCoverage(pf.plan),
    turnList: pf.turns.slice(0, 60).map((t) => ({ id: t.id, speaker: t.speaker, kind: t.kind, text: t.text.slice(0, 140) })) };
  if (b.action === "estimate") return { status: 200, body: { estimate } };
  if (b.action === "create") {
    if (!d.enabled) return DISABLED;
    if (estimate.overBudget) return { status: 402, body: { error: `El costo estimado (USD ${estimate.totalUsd.toFixed(2)}) supera tu presupuesto máximo (USD ${spec.budget_usd.toFixed(2)}). Sube el presupuesto o reduce apariciones del avatar.`, estimate } };
    const row = await d.insert({ user_id: d.userId, title: spec.title, mode: spec.mode, spec, status: "draft", estimate, estimated_usd: estimate.totalUsd });
    if (row === "missing") return DISABLED;
    if (!row) return { status: 500, body: { error: "No se pudo guardar el episodio." } };
    return { status: 200, body: { id: row.id, estimate } };
  }
  return { status: 400, body: { error: "Acción no válida." } };
}

/** Autorización explícita del cargo (paso 10). Requiere confirmación, monto ≥ estimación y ≤ presupuesto. */
export async function authorizeAction(d: ApiDeps, id: string, body: Record<string, unknown> | null): Promise<Out> {
  if (!d.enabled) return DISABLED;
  const row = await d.load(id);
  if (row === "missing") return DISABLED;
  if (!row || row.user_id !== d.userId) return { status: 404, body: { error: "Episodio no encontrado." } };
  if (row.status !== "draft" && row.status !== "failed") return { status: 409, body: { error: row.status === "generating" ? "Ya se está generando; no se inicia otra vez." : "Este episodio ya fue autorizado." } };
  if (body?.confirm !== true) return { status: 400, body: { error: "Confirma explícitamente el costo antes de generar." } };
  const usd = Number(body?.authorizedUsd);
  const spec = StudioSpec.safeParse(row.spec);
  if (!spec.success) return { status: 409, body: { error: "Especificación del episodio inválida." } };
  if (!Number.isFinite(usd) || usd < Number(row.estimated_usd ?? 0) - 1e-9) return { status: 402, body: { error: "El monto autorizado es menor que la estimación." } };
  if (usd > spec.data.budget_usd + 1e-9) return { status: 402, body: { error: "El monto autorizado supera el presupuesto máximo del episodio." } };
  if (!(await d.authorize(id, usd))) return { status: 409, body: { error: "Otra solicitud cambió el episodio; recarga la página." } };
  const dispatched = await d.dispatch(id);
  return { status: 200, body: { ok: true, dispatched, note: dispatched ? null : "Autorizado. No pudimos confirmar el inicio del trabajo; pulsa «Reintentar» (no se cobra dos veces)." } };
}
