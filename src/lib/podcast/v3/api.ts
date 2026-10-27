/**
 * Podcast 3.0 — lógica de las rutas /api/podcast/v3 separada de Next (probada con dependencias simuladas).
 * Nada aquí llama a proveedores de pago: crear y estimar son gratis; autorizar solo registra el monto aprobado y
 * despacha el trabajo (la generación ocurre en el worker con el libro de operaciones).
 */
import type { AccountVoice } from "@/lib/podcast/voices";
import type { VoiceViewer } from "@/lib/voices/private-voices";
import { StudioSpec, validateSpec, STUDIO_VERSION, type StudioSpec as Spec } from "./spec";
import { isPrivateVoice } from "@/lib/voices/private-voices";
import { preflight, type ImageProvider, type Providers } from "./pipeline";
import { generateConversation, type LlmFn } from "./script";
import { keywords, type VisualAsset } from "./editorial";
import { estimateHeygenCost } from "@/lib/providers/avatar/heygen";
import { getPricingConfig } from "@/lib/billing/pricing";
import { RECRAFT_USD_PER_IMAGE } from "@/lib/providers/image/recraft";
import type { StudioEpisodeRow } from "./store";
import { requireProvider, ProviderUnavailableError, visualProviders, lipTimeline, shotCoverage } from "./studio";

/** Proveedores de PLANIFICACIÓN (sin red, sin costo): solo para estimar; nunca generan medios. */
export function planningProviders(opts: { recreations?: boolean } = {}): Providers {
  const rate = getPricingConfig().elevenLabsUsdPer1kChars;
  // Con Recraft elegido (y activado), la estimación es el PEOR caso: el planificador solo usa recreaciones donde no hay
  // foto, así que se planifica sin fotos y se cuentan todas las que el worker podría pagar (gatherAssets: máx. 4).
  const images: ImageProvider = { name: "plan", label: "mock", async search(q) { return opts.recreations ? [] : [{ id: `plan-${q}`, query: q, kind: "foto", tags: keywords(q) } satisfies VisualAsset]; }, async fetch() { throw new Error("solo planificación"); },
    ...(opts.recreations ? { recreateProvider: "recraft", recreateUsd: RECRAFT_USD_PER_IMAGE, async recreate() { throw new Error("solo planificación"); } } : {}) };
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
  /** Runner perdido (audit F3, #200): CAS generating→failed para un inicio anterior a `startedBefore` y reserved→uncertain,
   *  igual que scripts/podcast-video-mark-failed.ts. Devuelve true si cambió exactamente el episodio. */
  markStale?: (id: string, startedBefore: string) => Promise<boolean>;
  /** El avatar existente pertenece al usuario y está listo (aislamiento por usuario). */
  ownsAvatar?: (avatarId: string) => Promise<boolean>;
  env?: Record<string, string | undefined>;
};
type Out = { status: number; body: Record<string, unknown> };
export const STUDIO_MAX_AUTHORIZED_USD = 50;
/** Más que el timeout del job de estudio (podcast-video.yml: 200 min): pasado esto, ningún runner sigue vivo. */
export const STUDIO_RUNNER_MAX_MS = 4 * 3600_000;
const DISABLED: Out = { status: 503, body: { error: "Los modos de estudio (avatar y conversación) se activan tras autorizar la migración y PODCAST_V3_ENABLED. La narración sigue disponible." } };

export async function studioAction(d: ApiDeps, body: Record<string, unknown> | null): Promise<Out> {
  const b = body ?? {};
  if (b.action === "script") {
    const topic = String(b.topic ?? "").trim().slice(0, 500);
    if (topic.length < 3) return { status: 400, body: { error: "Escribe un tema de al menos 3 caracteres." } };
    const minutes = Math.min(30, Math.max(1, Number(b.minutes) || 5));
    const host = String(b.hostName ?? "Anfitrión").slice(0, 60) || "Anfitrión", guest = String(b.guestName ?? "Invitado").slice(0, 60) || "Invitado";
    // El LLM (de pago) solo con el estudio activado; con el estudio apagado se usa la plantilla gratuita.
    const r = await generateConversation({ topic, hostName: host, guestName: guest, guestRole: String(b.guestRole ?? "").slice(0, 120), minutes, hostPersonality: String(b.hostPersonality ?? "").slice(0, 160), guestPersonality: String(b.guestPersonality ?? "").slice(0, 160) }, b.useAi === true && d.enabled ? d.llm : null);
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
  const env = d.env ?? process.env;
  const issues = validateSpec(spec, voices, d.viewer, env);
  if (issues.length) return { status: 400, body: { error: issues[0].message, issues } };
  // El cliente puede omitir voice_kind (el esquema pone «sintetica»). Un clon privado concedido se guarda como «clonada».
  const stored: Spec = { ...spec, participants: spec.participants.map((p) => {
    const v = voices.find((x) => x.voiceId === p.voice_id);
    return { ...p, voice_kind: v && isPrivateVoice(v) ? "clonada" : "sintetica" };
  }) };
  for (const p of spec.participants) {
    if (p.avatar.kind === "foto" && !p.avatar.photo_path.startsWith(`${d.userId}/podcast-studio/photos/`)) return { status: 403, body: { error: "La foto del avatar no pertenece a tu cuenta." } };
    if (p.avatar.kind === "existente" && d.ownsAvatar && !(await d.ownsAvatar(p.avatar.avatar_id))) return { status: 403, body: { error: "Ese avatar no está disponible en tu cuenta." } };
  }
  const pf = await preflight(stored, planningProviders({ recreations: stored.visual.provider === "recraft" }));
  const estimate = { lines: pf.estimate.lines, totalUsd: pf.estimate.totalUsd, assumptions: pf.estimate.assumptions, rates: pf.estimate.rates, turns: pf.turns.length, mood: pf.mood,
    shots: pf.plan.shots.reduce<Record<string, number>>((m, s) => ({ ...m, [s.kind]: (m[s.kind] ?? 0) + 1 }), {}), overBudget: pf.estimate.totalUsd > spec.budget_usd,
    byProvider: pf.estimate.lines.reduce<Record<string, number>>((m, l) => ({ ...m, [l.provider]: Math.round(((m[l.provider] ?? 0) + l.usd) * 1e4) / 1e4 }), {}),
    providers: visualProviders(d.env ?? process.env), lipTimeline: lipTimeline(pf.plan).slice(0, 40), coverage: shotCoverage(pf.plan),
    turnList: pf.turns.slice(0, 60).map((t) => ({ id: t.id, speaker: t.speaker, kind: t.kind, text: t.text.slice(0, 140) })) };
  if (b.action === "estimate") return { status: 200, body: { estimate } };
  if (b.action === "create") {
    if (!d.enabled) return DISABLED;
    if (estimate.overBudget) return { status: 402, body: { error: `El costo estimado (USD ${estimate.totalUsd.toFixed(2)}) supera tu presupuesto máximo (USD ${spec.budget_usd.toFixed(2)}). Sube el presupuesto o reduce apariciones del avatar.`, estimate } };
    const row = await d.insert({ user_id: d.userId, title: stored.title, mode: stored.mode, spec: stored, status: "draft", estimate, estimated_usd: estimate.totalUsd });
    if (row === "missing") return DISABLED;
    if (!row) return { status: 500, body: { error: "No se pudo guardar el episodio." } };
    return { status: 200, body: { id: row.id, estimate } };
  }
  return { status: 400, body: { error: "Acción no válida." } };
}

/** Autorización explícita del cargo (paso 10). Requiere confirmación, monto ≥ estimación y ≤ presupuesto. */
export async function authorizeAction(d: ApiDeps, id: string, body: Record<string, unknown> | null): Promise<Out> {
  if (!d.enabled) return DISABLED;
  let row = await d.load(id);
  if (row === "missing") return DISABLED;
  if (!row || row.user_id !== d.userId) return { status: 404, body: { error: "Episodio no encontrado." } };
  // Audit F3 (#200): «generating» cuyo runner ya no puede existir (inicio anterior al timeout del job) → se cierra como
  // lo haría mark-failed (lo reservado pasa a «uncertain», nunca a «released») y el dueño puede reintentar.
  if (row.status === "generating" && d.markStale && (!row.run_started_at || Date.parse(row.run_started_at) < Date.now() - STUDIO_RUNNER_MAX_MS)) {
    const before = new Date(Date.now() - STUDIO_RUNNER_MAX_MS).toISOString();
    if (await d.markStale(id, before)) {
      const again = await d.load(id);
      if (again === "missing" || !again || again.user_id !== d.userId) return { status: 409, body: { error: "Otra solicitud cambió el episodio; recarga la página." } };
      row = again;
    }
  }
  // El cargo ya quedó registrado y el worker no ha tomado el episodio: solo se vuelve a pedir el inicio.
  // No se llama a authorize (no cambia el monto) y el guard del worker impide una segunda generación.
  if (row.status === "authorized" && !row.run_started_at) {
    if (body?.confirm !== true) return { status: 400, body: { error: "Confirma explícitamente el costo antes de generar." } };
    const dispatched = await d.dispatch(id);
    return { status: 200, body: { ok: true, dispatched, note: dispatched ? null : "Autorizado. No pudimos confirmar el inicio del trabajo; pulsa «Reintentar» (no se cobra dos veces)." } };
  }
  if (row.status !== "draft" && row.status !== "failed") return { status: 409, body: { error: row.status === "generating" || row.status === "authorized" ? "Ya se está generando; no se inicia otra vez." : "Este episodio ya fue autorizado." } };
  if (body?.confirm !== true) return { status: 400, body: { error: "Confirma explícitamente el costo antes de generar." } };
  const usd = Number(body?.authorizedUsd);
  const spec = StudioSpec.safeParse(row.spec);
  if (!spec.success) return { status: 409, body: { error: "Especificación del episodio inválida." } };
  if (!Number.isFinite(usd) || usd < Number(row.estimated_usd ?? 0) - 1e-9) return { status: 402, body: { error: "El monto autorizado es menor que la estimación." } };
  if (usd > spec.data.budget_usd + 1e-9) return { status: 402, body: { error: "El monto autorizado supera el presupuesto máximo del episodio." } };
  // Tope duro por autorización (independiente del presupuesto que escriba el usuario): un error o un abuso no puede
  // autorizar más de STUDIO_MAX_AUTHORIZED_USD por episodio.
  if (usd > STUDIO_MAX_AUTHORIZED_USD + 1e-9) return { status: 402, body: { error: `Por seguridad, un episodio no puede autorizar más de USD ${STUDIO_MAX_AUTHORIZED_USD}.` } };
  if (!(await d.authorize(id, usd))) return { status: 409, body: { error: "Otra solicitud cambió el episodio; recarga la página." } };
  const dispatched = await d.dispatch(id);
  return { status: 200, body: { ok: true, dispatched, note: dispatched ? null : "Autorizado. No pudimos confirmar el inicio del trabajo; pulsa «Reintentar» (no se cobra dos veces)." } };
}

/**
 * GET del episodio de estudio (estado + enlaces de descarga firmados). Solo el dueño; solo rutas dentro de su carpeta
 * del episodio; enlaces solo cuando está «ready». Separado de Next para probar aislamiento y descarga sin red.
 */
export async function episodeAction(userId: string, row: StudioEpisodeRow | "missing" | null, sign: (path: string, name: string) => Promise<string | null>): Promise<Out> {
  if (row === "missing") return { status: 503, body: { error: "Requiere la migración del estudio." } };
  if (!row || row.user_id !== userId) return { status: 404, body: { error: "Episodio no encontrado." } };
  const signOwn = async (p: string | null, name: string) => (!p || !p.startsWith(`${userId}/podcast-studio/${row.id}/`) ? null : sign(p, name));
  const { spec: _spec, ...pub } = row;
  return { status: 200, body: { episode: pub, video_url: row.status === "ready" ? await signOwn(row.video_path, `${row.title}.mp4`) : null,
    audio_url: row.status === "ready" ? await signOwn(row.audio_path, `${row.title}.${row.audio_path?.split(".").pop() ?? "mp3"}`) : null } };
}
