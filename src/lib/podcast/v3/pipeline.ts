/**
 * Podcast 3.0 — orquestador de un episodio de estudio (modos A/B/C). Los proveedores se INYECTAN:
 *  - en pruebas/demos: simulados (mocks.ts), etiquetados «mock»;
 *  - en la app: adaptadores reales (adapters.ts) — ElevenLabs y HeyGen reutilizando el código existente,
 *    marcados «real adapter (untested live)» hasta una prueba real autorizada.
 * Garantías: estimación previa y autorización explícita; presupuesto máximo; una llamada de pago por clave
 * (reintentos reutilizan lo pagado); protección contra ejecuciones duplicadas; si la entrega falla, se liberan
 * reservas y el episodio no se cobra al usuario.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { getPricingConfig } from "@/lib/billing/pricing";
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ffmpeg, ffprobeDuration } from "./ffmpeg";
import { assembleVoice, exportAudio, mixAndMaster, transitionTimes, type TimelineEntry } from "./audio";
import { FPS, frameFor, muxEpisode, renderShot, shotFrames, type SubtitleWord } from "./compose";
import type { Matte } from "./studios";
import { progressRecord, stagesFor, type Stage, type StudioProgress } from "./progress";
import { estimateEpisodeCost, opKey, paidOnce, releaseUndelivered, committedUsd, BudgetExceededError, UnauthorizedChargeError, type CostEstimate, type SpendTicket, type StudioLedger } from "./cost";
import { NEGATIVE_ACTUAL, keywords, salientTerms, planEpisode, planIssues, topicEra, type EditorialPlan, type VisualAsset } from "./editorial";
import { autoMood, ensureBundledMusic } from "./music-library";
import { estimateSeconds, narrationTurns, parseLabeledScript, type Turn } from "./script";
import type { Mood, StudioSpec } from "./spec";

export type ProviderLabel = "mock" | "real adapter (untested live)";
export type TtsProvider = { name: string; label: ProviderLabel; model: string;
  /** `words`: tiempos de cada palabra del audio (s desde el inicio del turno), para subtítulos sincronizados. */
  synth(text: string, voiceId: string, dest: string): Promise<{ actualUsd: number; words?: SubtitleWord[] }>; usdFor(chars: number): number };
export type AvatarProvider = { name: string; label: ProviderLabel;
  /** Genera el clip con lip-sync a partir del audio del turno (HeyGen: foto/avatar + audio propio). */
  render(avatarRef: string, audioFile: string, seconds: number, dest: string, maxUsd: number): Promise<{ actualUsd: number }>;
  /** Fotograma fijo del avatar (sin costo): foto/preview del avatar. */
  still(avatarRef: string, dest: string): Promise<void>; usdFor(seconds: number): number;
  /** Comprueba (sin costo) que la foto fija del avatar se puede leer. Se usa ANTES del primer cargo. */
  checkStill?: (avatarRef: string) => Promise<boolean>;
  /**
   * Prepara un avatar desde foto (HeyGen: sube la foto como asset) y devuelve la referencia del proveedor. Pasa por el
   * libro de operaciones con su propia clave: un reintento reutiliza la referencia y no vuelve a subir/cobrar.
   */
  prepare?: (photoRef: string) => Promise<{ ref: string; actualUsd: number }>; prepareUsd?: number };
export type ImageProvider = { name: string; label: ProviderLabel;
  /** Ilustración generada (Recraft, de pago) para un turno: la descripción la escribe el director visual. */
  generate?: (req: { prompt: string; negative: string; aspect: "16:9" | "9:16"; attempt: number; styleMatch?: "precise" | "flexible" }, dest: string, ticket?: SpendTicket) => Promise<{ actualUsd: number }>;
  /** Costo por imagen y costo único de crear el estilo del episodio (primera imagen). */
  generateUsd?: number; styleUsd?: number;
  /** Banco de imágenes (solo planificación y pruebas). El estudio ya no busca fotos de archivo en producción. */
  search?: (query: string, limit?: number) => Promise<VisualAsset[]>; fetch?: (asset: VisualAsset, dest: string) => Promise<void>;
  /** Recreación generada (de pago, flujo anterior). */
  recreate?: (prompt: string, dest: string) => Promise<{ actualUsd: number }>; recreateUsd?: number };
/** Qué debe mostrar la imagen de un turno (lo escribe el director visual a partir del contenido de la intervención). */
export type TurnBrief = { turn_id: string; prompt: string; subject: string; recreation: boolean; era?: "historica" | "actual" };
/**
 * Director visual (de pago, Anthropic): describe la imagen de cada turno y COMPRUEBA cada imagen generada mirándola.
 * Las palabras del prompt no prueban lo que muestra la imagen: el veredicto sale de la imagen misma.
 */
export type VisualDirector = { label: ProviderLabel;
  /** Nombre del proveedor en el libro de operaciones («clip» local sin costo, o un proveedor de pago). */
  name: string;
  brief(input: { topic: string; title: string; language: "es" | "en"; turns: { id: string; text: string }[] }): Promise<{ briefs: TurnBrief[]; actualUsd: number }>;
  /** Verificación EN LOTE (una llamada para todas las imágenes: la cuota diaria de llamadas es pequeña). */
  verify(items: { image: string; brief: TurnBrief }[], topic: string): Promise<{ verdicts: { ok: boolean; reason: string }[]; actualUsd: number }>;
  /** Costo de la llamada del guion visual, base de cada lote de verificación y añadido por imagen verificada. */
  briefUsd: number; verifyUsd: number; verifyBatchUsd?: number };
/** Recorta a una persona de su fondo (clip o foto fija). Sin él (pruebas), el recorte es el encuadre completo. */
export type Matter = (input: string, outBase: string, still: boolean) => Promise<Matte>;
/** Lo que el episodio necesita de cada proveedor antes de empezar (para verificar saldo sin gastar). */
export type ProviderNeeds = { ttsChars: number; ttsUsd: number; avatarUsd: number; imagesUsd: number;
  /** New (not yet settled) paid calls per provider, for the providers' daily call quotas. */
  ttsCalls?: number; avatarCalls?: number; imagesCalls?: number };
export type Providers = { tts: TtsProvider; avatar: AvatarProvider; images: ImageProvider; director?: VisualDirector; matte?: Matter;
  /** Verificación GRATUITA previa (credenciales y saldo). Devuelve el motivo del bloqueo o null. Sin ella no se verifica saldo. */
  readiness?: (needs: ProviderNeeds) => Promise<string | null> };
export class ProviderNotReadyError extends Error { constructor(why: string) { super(`Proveedor no listo: ${why} No se hizo ningún cargo.`); this.name = "ProviderNotReadyError"; } }
export class StillUnavailableError extends Error { constructor() { super("FOTO: la foto fija del avatar no está disponible. No se hizo ningún cargo."); this.name = "StillUnavailableError"; } }

/**
 * Almacén de lo ya PAGADO (voz, clips de avatar, recreaciones). El libro guarda la referencia del almacén, no una ruta
 * local: un reintento en OTRO runner (los de GitHub son efímeros) recupera el archivo en vez de volver a pagarlo.
 */
export interface ArtifactStore { put(key: string, localFile: string): Promise<string>; get(ref: string, localDest: string): Promise<void> }
export class PaidArtifactMissingError extends Error { constructor(op: string) { super(`Lo ya pagado (${op}) no está disponible para reutilizarlo; no se vuelve a pagar. Requiere revisión.`); this.name = "PaidArtifactMissingError"; } }
/** Tarifas con las que se ESTIMÓ y AUTORIZÓ el episodio: el worker reserva con estas mismas (una sola fuente). */
export type StudioRates = { voiceUsdPer1kChars: number };

export interface RunGuard { acquire(episode: string, token: string): Promise<boolean>; release(episode: string, token: string): Promise<void> }
export class MemoryRunGuard implements RunGuard {
  private m = new Map<string, string>();
  async acquire(e: string, t: string) { if (this.m.has(e)) return false; this.m.set(e, t); return true; }
  async release(e: string, t: string) { if (this.m.get(e) === t) this.m.delete(e); }
}
export class DuplicateRunError extends Error { constructor() { super("Ya hay una generación en curso para este episodio; no se inicia otra."); this.name = "DuplicateRunError"; } }
/** El perdedor de una carrera no debe marcar el episodio «failed»: el ganador sigue y, si no, lo dejaría en error con el archivo ya listo. */
export function studioRunErrorFailsEpisode(e: unknown): boolean {
  return !(e instanceof DuplicateRunError);
}

export type StudioTurns = { turns: Turn[]; names: Record<"A" | "B", string> };
/** Turnos según el modo: guion etiquetado (diálogo) o párrafos (narración/avatar; 2 voces alternan). */
export function turnsFor(spec: StudioSpec): StudioTurns {
  const names = { A: spec.participants[0]?.name ?? "A", B: spec.participants[1]?.name ?? "B" };
  if (spec.mode === "dialogo") {
    const p = parseLabeledScript(spec.script, names);
    if (!p) throw new Error("El guion de conversación necesita etiquetas de hablante (por ejemplo «Ana: …» y «Luis: …»).");
    return { turns: p.turns, names };
  }
  const labeled = spec.participants.length === 2 ? parseLabeledScript(spec.script, names) : null;
  return { turns: labeled?.turns ?? narrationTurns(spec.script, spec.participants.length === 2 ? 2 : 1), names };
}

export const INTRO_SECONDS = 3, OUTRO_SECONDS = 2.5;
/** Imágenes del tema (búsqueda del ancla sola) disponibles para turnos sin imagen propia. */
const TOPIC_POOL = 8;

/** Activos candidatos por turno (búsqueda deduplicada por consulta). */
/** Términos del tema del episodio (los mismos que anclan las búsquedas). */
export function topicTermsFor(spec: StudioSpec, turns: Turn[]): string[] {
  return salientTerms(spec.topic, turns.map((t) => t.text), 2, spec.title);
}

export async function gatherAssets(turns: Turn[], images: ImageProvider, title: string, recreations: boolean, topic = ""): Promise<VisualAsset[]> {
  // Recraft: una ilustración por turno, descrita después por el director visual con el contenido de la intervención.
  // Sin búsquedas: lo que decide la pertinencia es la verificación de la imagen generada, no unas palabras clave.
  if (images.generate) return turns.map((t) => ({ id: `rc-${t.id}`, query: t.text.slice(0, 240), kind: "ilustracion" as const, tags: keywords(t.text), forTurn: t.id }));
  if (!images.search) return [];
  const search = images.search;
  const seen = new Map<string, VisualAsset>();
  const queries = new Set<string>();
  // Cada búsqueda lleva el ancla del tema + las palabras propias del turno (sin repetir el ancla).
  const anchor = salientTerms(topic, turns.map((t) => t.text), 2, title);
  // Fondo del tema (P2 real 2026-10-28: cuatro turnos sin palabra propia del tema quedaron en planos vacíos de 2-5 s):
  // la búsqueda del ancla sola trae más imágenes del tema, que el plan usa cuando un turno no tiene imagen propia.
  if (anchor.length) for (const a of await search(anchor.join(" "), TOPIC_POOL).catch(() => [])) if (!seen.has(a.id)) seen.set(a.id, a);
  for (const t of turns) { const kw = keywords(t.text).filter((w) => !anchor.includes(w)).slice(0, anchor.length ? 2 : 3); if (kw.length || anchor.length) queries.add([...anchor, ...kw].join(" ")); }
  for (const q of queries) for (const a of await search(q).catch(() => [])) if (!seen.has(a.id)) seen.set(a.id, a);
  if (recreations && images.recreate) for (const t of turns.filter((x) => x.kind === "narracion" || x.kind === "respuesta").slice(0, 4)) {
    const kw = keywords(t.text).slice(0, 4);
    if (kw.length) seen.set(`rec-${t.id}`, { id: `rec-${t.id}`, query: `${title}: ${kw.join(" ")}`, kind: "recreacion", tags: kw });
  }
  return [...seen.values()];
}

const assetKind = (assets: VisualAsset[], id: string) => assets.find((a) => a.id === id)?.kind;
/** Regeneraciones permitidas por episodio (una imagen que no pasa la verificación se pide otra vez, hasta este tope). */
export const imageRetries = (images: number) => Math.ceil(images * 0.25);

type Pay = (provider: string, op: string, payload: unknown, usd: number, call: (ticket: SpendTicket) => Promise<{ result: string; actualUsd: number }>, dest?: string) => Promise<string>;
/** Lo que nunca debe aparecer en una ilustración del podcast (Recraft lo recibe como «Avoid»). */
export const NEGATIVE_IMAGE = "text, letters, captions, watermarks, logos, airplanes, cars, phones, modern objects unrelated to the topic, holiday decorations, clothing catalog, product photos";

/** Descripción mínima de un turno cuando no hay director visual (pruebas): el tema y las palabras del propio turno. */
export function fallbackBrief(spec: StudioSpec, turnId: string, text: string): TurnBrief {
  const kw = keywords(text).slice(0, 6);
  return { turn_id: turnId, prompt: `${spec.topic || spec.title}: ${kw.join(", ")}`, subject: kw.slice(0, 3).join(", ") || spec.topic || spec.title, recreation: false };
}

/** Guion visual del episodio: una llamada (de pago, reutilizada al reintentar) que describe la imagen de cada turno. */
async function visualBriefs(spec: StudioSpec, turns: Turn[], providers: Providers, pay: Pay): Promise<Map<string, TurnBrief>> {
  const out = new Map<string, TurnBrief>();
  const director = providers.director;
  let list: TurnBrief[] = [];
  if (director && turns.length) {
    const input = { topic: spec.topic, title: spec.title, language: spec.language, turns: turns.map((t) => ({ id: t.id, text: t.text })) };
    const json = await pay(director.name, "guion_visual", input, director.briefUsd, async () => { const r = await director.brief(input); return { result: JSON.stringify(r.briefs), actualUsd: r.actualUsd }; });
    try { list = JSON.parse(json) as TurnBrief[]; } catch { list = []; }
  }
  for (const t of turns) out.set(t.id, list.find((b) => b.turn_id === t.id && b.prompt?.trim()) ?? fallbackBrief(spec, t.id, t.text));
  // Directores que no dicen la época (el de IA, la alternativa): se deduce del tema y de los turnos.
  const era = topicEra(spec.topic || spec.title, turns.map((t) => t.text));
  for (const [k, b] of out) if (!b.era) out.set(k, { ...b, era });
  return out;
}

/** Veredictos de un lote de imágenes generadas (de pago, guardado: un reintento no vuelve a pagar la comprobación). */
async function verifyImages(providers: Providers, pay: Pay, items: { image: string; brief: TurnBrief; key: string }[], topic: string): Promise<{ ok: boolean; reason: string }[]> {
  const director = providers.director;
  if (!director || !items.length) return items.map(() => ({ ok: true, reason: "" }));
  const usd = (director.verifyBatchUsd ?? 0) + items.length * director.verifyUsd;
  const raw = await pay(director.name, "verificacion", { images: items.map((x) => x.key), subjects: items.map((x) => x.brief.subject) }, usd, async () => {
    const r = await director.verify(items.map(({ image, brief }) => ({ image, brief })), topic);
    return { result: JSON.stringify(r.verdicts.map((v) => ({ ok: v.ok, reason: v.reason }))), actualUsd: r.actualUsd };
  });
  let list: { ok?: unknown; reason?: unknown }[] = [];
  try { list = JSON.parse(raw); } catch { list = []; }
  // Sin veredicto legible para una imagen → no se da por buena (se trata como rechazada).
  return items.map((_, i) => ({ ok: list[i]?.ok === true, reason: String(list[i]?.reason ?? "sin veredicto") }));
}

/** Recorte de respaldo (sin modelo de recorte): la persona con su encuadre completo, opaca. Solo pruebas. */
export const opaqueMatte: Matter = async (input, _out, still) => {
  const { stdout } = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", input], { encoding: "utf8" });
  const [w, h] = String(stdout ?? "").trim().split(",").map(Number);
  return { fg: input, alpha: null, w: w || 480, h: h || 640, face: null, still };
};

export type Preflight = { turns: Turn[]; names: Record<"A" | "B", string>; plan: EditorialPlan; estimate: CostEstimate; mood: Mood; ttsChars: number; assets: VisualAsset[] };

/** Paso 9 del asistente: plan y costo ANTES de generar (sin llamadas de pago; búsqueda de imágenes gratuita). */
export async function preflight(spec: StudioSpec, providers: Providers, rates?: StudioRates): Promise<Preflight> {
  const { turns, names } = turnsFor(spec);
  const audioOnly = spec.output === "audio";
  const assets = audioOnly || spec.visual.provider === "solo_set" ? [] : await gatherAssets(turns, providers.images, spec.title, spec.visual.recreations, spec.topic);
  const plan = planEpisode({ mode: spec.mode, turns, assets, topicTerms: topicTermsFor(spec, turns), avatarFrequency: spec.mode === "narracion" ? 0 : spec.visual.avatar_frequency, avatarMaxSeconds: spec.visual.avatar_max_seconds,
    recreations: spec.visual.recreations, hasAvatar: { A: hasAvatar(spec, "A"), B: hasAvatar(spec, "B") }, introSeconds: INTRO_SECONDS });
  const ttsChars = turns.reduce((n, t) => n + t.text.length, 0);
  const seconds = INTRO_SECONDS + OUTRO_SECONDS + turns.reduce((n, t) => n + estimateSeconds(t.text) + 0.4, 0);
  const pricing = rates ? { ...getPricingConfig(), elevenLabsUsdPer1kChars: rates.voiceUsdPer1kChars } : undefined;
  const illustrations = plan.shots.filter((x) => x.asset_id && assetKind(assets, x.asset_id) === "ilustracion").length;
  const estimate = estimateEpisodeCost({ ttsChars, plan, recreationImages: plan.shots.filter((s) => s.kind === "recreacion").length, episodeSeconds: seconds, pricing,
    avatarCreations: spec.participants.filter((p) => p.avatar.kind === "foto").length, renderMinutesFactor: audioOnly ? 0.2 : undefined, audioOnly,
    ...(providers.images.generate ? { illustrations: { count: illustrations, usdPerImage: providers.images.generateUsd ?? 0, styleUsd: providers.images.styleUsd ?? 0, retries: imageRetries(illustrations) } } : {}),
    ...(providers.director ? { director: { briefUsd: providers.director.briefUsd, verifyUsd: providers.director.verifyUsd, verifyBatchUsd: providers.director.verifyBatchUsd } } : {}) });
  const mood = spec.music.mood === "auto" ? autoMood(spec.script) : spec.music.mood;
  return { turns, names, plan, estimate, mood, ttsChars, assets };
}
/** Avatares que pueden aparecer como oyentes (foto fija): ambos en «diálogo» con dos avatares y algún plano de avatar. */
export function stillListeners(spec: StudioSpec, plan: EditorialPlan): ("A" | "B")[] {
  const isAv = (k: string) => k === "avatar_a" || k === "avatar_b" || k === "two_shot" || k === "over_shoulder";
  return spec.mode === "dialogo" && hasAvatar(spec, "A") && hasAvatar(spec, "B") && plan.shots.some((s) => isAv(s.kind)) ? ["A", "B"] : [];
}
const hasAvatar = (spec: StudioSpec, id: "A" | "B") => { const p = spec.participants.find((x) => x.id === id); return !!p && p.avatar.kind !== "ninguno"; };
const avatarRef = (spec: StudioSpec, id: "A" | "B") => { const a = spec.participants.find((x) => x.id === id)?.avatar; return a?.kind === "existente" ? a.avatar_id : a?.kind === "foto" ? `foto:${a.photo_path}` : a?.kind === "catalogo" ? `catalogo:${a.host_id}` : ""; };

export type RunResult = {
  /** null en «solo audio»: no se renderiza video. */
  ok: true; mp4: string | null; audio: string; durationSeconds: number; lufs: number; truePeak: number; clipped: number; musicTrack: string | null; mood: Mood;
  plan: EditorialPlan; timeline: TimelineEntry[]; spentUsd: number; reusedOps: number; paidOps: number; providers: Record<string, ProviderLabel>; charged: true; shotFiles: string[];
};

export async function runEpisode(spec: StudioSpec, ctx: { owner: string; episode: string; dir: string; providers: Providers; ledger: StudioLedger; guard: RunGuard; authorizedUsd: number | null; small?: boolean; musicDir?: string; onProgress?: (p: StudioProgress) => void;
  /** Persistencia de lo pagado entre runners (obligatoria en el worker real). */ artifacts?: ArtifactStore;
  /** Tarifas del episodio autorizado (las de la estimación guardada). */ rates?: StudioRates;
  /** Autorización duradera del dueño (`authorized_at` del episodio): viaja en el comprobante de cada operación de pago. */
  authorizationRef?: string | null }): Promise<RunResult> {
  const token = createHash("sha1").update(`${ctx.episode}:${Date.now()}:${Math.random()}`).digest("hex");
  if (!(await ctx.guard.acquire(ctx.episode, token))) throw new DuplicateRunError();
  const progress = ctx.onProgress ?? (() => {});
  try {
    await mkdir(ctx.dir, { recursive: true });
    const pf = await preflight(spec, ctx.providers, ctx.rates);
    // Autorización explícita: el usuario aprobó un monto ≥ estimación; el tope efectivo es min(autorizado, presupuesto del episodio).
    const authorized = ctx.authorizedUsd != null && ctx.authorizedUsd + 1e-9 >= pf.estimate.totalUsd - pf.estimate.lines.find((l) => l.concept === "render")!.usd;
    const budget = Math.min(spec.budget_usd, ctx.authorizedUsd ?? 0);
    if (!authorized) throw new UnauthorizedChargeError();
    // Presupuesto previo: si lo estimado (sin el runner) no cabe en el tope efectivo, no se empieza (ningún cargo).
    const line = (c: string) => pf.estimate.lines.find((l) => l.concept === c)?.usd ?? 0;
    const providerUsd = Math.round((pf.estimate.totalUsd - line("render")) * 1e4) / 1e4;
    if (providerUsd > budget + 1e-9) throw new BudgetExceededError(providerUsd, budget);
    // Saldo/credenciales de los proveedores ANTES de la primera llamada de pago (verificación gratuita).
    if (ctx.providers.readiness) {
      // Calls still to make: what is already settled in the ledger is reused, never called again (P2 real 2026-10-28: the
      // voice quota ran out after 6 of 14 turns and the episode failed after paying them).
      const settledRows = (await ctx.ledger.byEpisode(ctx.episode)).filter((r) => r.state === "settled");
      const settled = new Set(settledRows.map((r) => r.key));
      const voiceFor = (s: "A" | "B") => spec.participants.find((p) => p.id === s)?.voice_id ?? spec.participants[0].voice_id;
      const ttsCalls = pf.turns.filter((t) => !settled.has(opKey({ owner: ctx.owner, episode: ctx.episode, provider: ctx.providers.tts.name, op: "tts",
        payload: { voice: voiceFor(t.speaker), model: ctx.providers.tts.model, text: t.text } }))).length;
      // Avatar clips of the preliminary plan (the definitive plan is re-checked by the cap trigger before each call) plus
      // the photo preparations, minus those already settled.
      const count = (op: string) => settledRows.filter((r) => r.op === op).length;
      const onCamera = pf.plan.shots.filter((s) => s.kind === "avatar_a" || s.kind === "avatar_b" || s.kind === "two_shot" || s.kind === "over_shoulder");
      const prepares = ctx.providers.avatar.prepare ? spec.participants.filter((p) => (p.avatar.kind === "foto" || p.avatar.kind === "catalogo") && onCamera.some((s) => s.speaker === p.id)).length : 0;
      const avatarCalls = spec.output === "audio" ? 0 : Math.max(0, onCamera.length - count("avatar_clip")) + Math.max(0, prepares - count("avatar_prepare"));
      const illustrations = pf.plan.shots.filter((x) => x.asset_id && assetKind(pf.assets, x.asset_id) === "ilustracion").length;
      const imagesCalls = spec.output === "audio" ? 0 : Math.max(0, illustrations + imageRetries(illustrations) - count("ilustracion"));
      const why = await ctx.providers.readiness({ ttsChars: pf.ttsChars, ttsUsd: line("voz"), avatarUsd: line("avatar"), imagesUsd: line("imagenes"), ttsCalls, avatarCalls, imagesCalls });
      if (why) throw new ProviderNotReadyError(why);
    }
    // Foto fija de quien escucha en los planos de conversación: se comprueba ANTES del primer cargo (P2 real: se leía
    // después de pagar voz y un clip). Solo hay oyentes en «diálogo» con dos avatares, y ahí se comprueban LOS DOS: el
    // plan definitivo (duraciones reales) puede convertir un primer plano en «sobre el hombro» que el preliminar no tiene.
    // Un avatar fuera de una conversación de dos avatares nunca escucha: no se comprueba ni bloquea.
    if (spec.output !== "audio" && ctx.providers.avatar.checkStill && stillListeners(spec, pf.plan).length) {
      for (const s of stillListeners(spec, pf.plan)) if (!(await ctx.providers.avatar.checkStill(avatarRef(spec, s)).catch(() => false))) throw new StillUnavailableError();
    }
    let reused = 0, paid = 0;
    const keyOf = (provider: string, op: string, payload: unknown) => opKey({ owner: ctx.owner, episode: ctx.episode, provider, op, payload });
    /** `dest`: archivo local que produce la operación. Con almacén, el libro guarda la referencia persistente. */
    const pay = async (provider: string, op: string, payload: unknown, usd: number, call: (ticket: SpendTicket) => Promise<{ result: string; actualUsd: number }>, dest?: string) => {
      const key = keyOf(provider, op, payload);
      const store = dest ? ctx.artifacts : undefined;
      const r = await paidOnce(ctx.ledger, { key, owner: ctx.owner, episode: ctx.episode, provider, op, usd, budgetUsd: budget, authorized, authorizationRef: ctx.authorizationRef ?? null },
        store ? async (t) => { const out = await call(t); return { result: await store.put(key, out.result), actualUsd: out.actualUsd }; } : call);
      if (r.reused) reused++; else paid++;
      if (!dest) return r.result;
      if (!r.reused) return dest;
      // Reutilización: traer lo pagado del almacén; una ruta local antigua solo vale si sigue existiendo.
      if (store && !r.result.startsWith("/")) { try { await store.get(r.result, dest); return dest; } catch { throw new PaidArtifactMissingError(op); } }
      if (existsSync(r.result)) return r.result;
      throw new PaidArtifactMissingError(op);
    };
    // 0) Avatares desde foto: preparación idempotente (una vez por foto y episodio, registrada en el libro).
    const prepared: Partial<Record<"A" | "B", string>> = {};
    if (spec.output !== "audio") for (const p of spec.participants) {
      if ((p.avatar.kind !== "foto" && p.avatar.kind !== "catalogo") || !pf.plan.shots.some((s) => s.speaker === p.id && (s.kind === "avatar_a" || s.kind === "avatar_b" || s.kind === "two_shot" || s.kind === "over_shoulder"))) continue;
      const prepare = ctx.providers.avatar.prepare;
      if (!prepare) continue;
      const ref = avatarRef(spec, p.id);
      prepared[p.id] = await pay(ctx.providers.avatar.name, "avatar_prepare", { photo: ref }, ctx.providers.avatar.prepareUsd ?? 0, async () => { const r = await prepare(ref); return { result: r.ref, actualUsd: r.actualUsd }; });
    }
    // Avance por trabajo completado (progress.ts): etapas reales del episodio, unidades terminadas en cada una.
    const isAvatarShot = (k: string) => k === "avatar_a" || k === "avatar_b" || k === "two_shot" || k === "over_shoulder";
    const video = spec.output !== "audio";
    const stages = stagesFor({ video, images: pf.plan.shots.some((x) => !!x.asset_id), avatars: pf.plan.shots.some((x) => isAvatarShot(x.kind)) });
    const step = (stage: Stage, done: number, total: number) => progress(progressRecord(stages, stage, done, total));
    step("preparacion", 1, 1);
    // 1) Voz por turno (cada turno con la voz de su participante; las voces alternan según el guion). Con la voz se
    // guardan los tiempos de cada palabra (ElevenLabs los devuelve con el audio): los subtítulos van sincronizados.
    const voiceOf = (s: "A" | "B") => spec.participants.find((p) => p.id === s)?.voice_id ?? spec.participants[0].voice_id;
    const turnAudio = [];
    const ttsKey = new Map<string, string>();
    const turnWords = new Map<string, SubtitleWord[]>();
    step("voces", 0, pf.turns.length);
    for (const [i, t] of pf.turns.entries()) {
      const dest = path.join(ctx.dir, `tts-${t.id}.mp3`);
      const wordsFile = `${dest}.palabras.json`;
      const payload = { voice: voiceOf(t.speaker), model: ctx.providers.tts.model, text: t.text };
      const key = keyOf(ctx.providers.tts.name, "tts", payload);
      const file = await pay(ctx.providers.tts.name, "tts", payload, ctx.providers.tts.usdFor(t.text.length), async () => {
        const r = await ctx.providers.tts.synth(t.text, payload.voice, dest);
        if (r.words?.length) {
          await writeFile(wordsFile, JSON.stringify(r.words));
          if (ctx.artifacts) await ctx.artifacts.put(key, wordsFile).catch(() => undefined); // mismo nombre, extensión .json
        }
        return { result: dest, actualUsd: r.actualUsd };
      }, dest);
      if (!existsSync(wordsFile) && ctx.artifacts) {
        const ref = (await ctx.ledger.get(key))?.result;
        if (ref && /\.mp3$/.test(ref)) await ctx.artifacts.get(ref.replace(/\.mp3$/, ".json"), wordsFile).catch(() => undefined);
      }
      if (existsSync(wordsFile)) { try { turnWords.set(t.id, JSON.parse(await readFile(wordsFile, "utf8"))); } catch { /* sin tiempos: reparto proporcional */ } }
      ttsKey.set(t.id, key);
      turnAudio.push({ turn_id: t.id, speaker: t.speaker, file, pause_after: (i + 1) % 6 === 0 && i < pf.turns.length - 1 ? 1.2 : undefined });
      step("voces", i + 1, pf.turns.length);
    }
    const voice = await assembleVoice(ctx.dir, turnAudio, INTRO_SECONDS, OUTRO_SECONDS);
    // 2) Plan definitivo con duraciones reales.
    const realTurns = pf.turns.map((t, i) => ({ ...t, seconds: (i + 1 < voice.timeline.length ? voice.timeline[i + 1].start : voice.duration) - voice.timeline[i].start }));
    const plan = planEpisode({ mode: spec.mode, turns: realTurns, assets: pf.assets, topicTerms: topicTermsFor(spec, pf.turns), avatarFrequency: spec.mode === "narracion" ? 0 : spec.visual.avatar_frequency, avatarMaxSeconds: spec.visual.avatar_max_seconds,
      recreations: spec.visual.recreations, hasAvatar: { A: hasAvatar(spec, "A"), B: hasAvatar(spec, "B") }, introSeconds: voice.timeline[0]?.start ?? INTRO_SECONDS });
    const issues = planIssues(plan);
    if (issues.length) throw new Error(`Plan editorial inválido: ${issues.join("; ")}`);
    // Segundo control con duraciones REALES: si los clips de avatar ya no caben en el tope, se para ANTES de pedirlos
    // (la voz pagada queda guardada y se reutiliza al reintentar con un monto mayor). Lo ya liquidado de avatar se reutiliza.
    if (video) {
      const rf = shotFrames(plan.shots, voice.duration);
      const need = Math.round(plan.shots.reduce((n, s, i) => n + (isAvatarShot(s.kind) ? ctx.providers.avatar.usdFor(Math.max(1, rf[i] / FPS)) : 0), 0) * 1e4) / 1e4;
      const rows = await ctx.ledger.byEpisode(ctx.episode);
      const settledAvatar = rows.filter((x) => x.op === "avatar_clip" && x.state === "settled").reduce((n, x) => n + (x.actual_usd ?? x.reserved_usd), 0);
      const free = budget - (await committedUsd(ctx.ledger, ctx.episode)) + settledAvatar;
      if (need > free + 1e-9) throw new BudgetExceededError(need, Math.round(free * 1e4) / 1e4);
    }
    // 3) Música y master.
    const musicDir = (await ensureBundledMusic(ctx.musicDir)).dir;
    const mix = await mixAndMaster(ctx.dir, voice.file, { musicDir, enabled: spec.music.enabled, mood: pf.mood, volumeDb: spec.music.volume_db, stings: spec.music.stings || spec.music.intro || spec.music.outro, ambient: spec.music.ambient, transitions: spec.music.stings ? transitionTimes(voice.timeline) : [], ducking: spec.music.ducking, intro: spec.music.intro, outro: spec.music.outro });
    const audioOut = path.join(ctx.dir, `episodio.${spec.audio_export}`);
    await exportAudio(mix.master, audioOut, spec.audio_export);
    const labels = { tts: ctx.providers.tts.label, avatar: ctx.providers.avatar.label, images: ctx.providers.images.label };
    if (!video) {
      // Solo audio: no se generan imágenes, no se renderizan planos ni se genera MP4.
      step("guardado", 0, 1);
      return { ok: true, mp4: null, audio: audioOut, durationSeconds: await ffprobeDuration(audioOut), lufs: mix.lufs, truePeak: mix.truePeak, clipped: mix.clipped, musicTrack: mix.track?.file ?? null, mood: pf.mood, plan, timeline: voice.timeline,
        spentUsd: await committedUsd(ctx.ledger, ctx.episode), reusedOps: reused, paidOps: paid, charged: true, shotFiles: [], providers: labels };
    }
    const turnText = new Map(pf.turns.map((t) => [t.id, t.text]));
    const turnLine = new Map(voice.timeline.map((e) => [e.turn_id, e]));
    // 4) Imágenes: una ilustración por plano de imagen, descrita por el contenido del turno y COMPROBADA mirándola.
    // Si no muestra lo pedido se regenera una vez (dentro del margen estimado); si tampoco, el plano pasa a una tarjeta
    // con la idea del turno: una alternativa explícita, nunca una foto cualquiera de un banco.
    const images = new Map<number, string>();
    const imageShots = plan.shots.map((x, i) => ({ x, i })).filter(({ x }) => !!x.asset_id);
    if (imageShots.length) {
      const generated = imageShots.filter(({ x }) => assetKind(pf.assets, x.asset_id!) === "ilustracion" && ctx.providers.images.generate);
      const units = imageShots.length + generated.length; // generar + verificar
      let doneUnits = 0;
      step("imagenes", 0, units);
      const briefs = await visualBriefs(spec, pf.turns.filter((t) => generated.some(({ x }) => x.turn_id === t.id)), ctx.providers, pay);
      let retries = imageRetries(generated.length);
      const gen = async (asset: VisualAsset, brief: TurnBrief, attempt: number, reason: string) => {
        const dest = path.join(ctx.dir, `img-${asset.id.replace(/[^\w-]/g, "_")}-${attempt}.png`);
        const prompt = attempt === 1 ? brief.prompt : `${brief.prompt}. The image must clearly show: ${brief.subject}. Do not include: ${reason || "anything unrelated to the topic"}.`;
        const payload = { prompt, aspect: spec.format, attempt };
        const file = await pay(ctx.providers.images.name, "ilustracion", payload, (ctx.providers.images.generateUsd ?? 0) + (ctx.providers.images.styleUsd ?? 0),
          async (ticket) => {
            const actual = brief.era === "actual";
            const r = await ctx.providers.images.generate!({ prompt, negative: actual ? NEGATIVE_ACTUAL : NEGATIVE_IMAGE, aspect: spec.format, attempt, ...(actual ? { styleMatch: "flexible" as const } : {}) }, dest, ticket);
            return { result: dest, actualUsd: r.actualUsd };
          }, dest);
        return { image: file, brief, key: keyOf(ctx.providers.images.name, "ilustracion", payload) };
      };
      // Primera pasada: una ilustración por plano; luego UNA verificación del lote.
      const first = [];
      for (const { x } of generated) {
        const asset = pf.assets.find((a) => a.id === x.asset_id)!;
        first.push(await gen(asset, briefs.get(asset.forTurn!) ?? fallbackBrief(spec, asset.forTurn!, turnText.get(asset.forTurn!) ?? ""), 1, ""));
        step("imagenes", ++doneUnits, units);
      }
      const verdicts = await verifyImages(ctx.providers, pay, first, spec.topic || spec.title);
      // Segunda pasada: las rechazadas se regeneran una vez (dentro del margen estimado) y se verifican en otro lote.
      const again: { k: number; item: Awaited<ReturnType<typeof gen>> }[] = [];
      for (const [k, v] of verdicts.entries()) {
        if (v.ok || retries <= 0) continue;
        retries--;
        const asset = pf.assets.find((a) => a.id === generated[k].x.asset_id)!;
        again.push({ k, item: await gen(asset, first[k].brief, 2, v.reason) });
      }
      const second = await verifyImages(ctx.providers, pay, again.map((a) => a.item), spec.topic || spec.title);
      for (const [j, a] of again.entries()) if (second[j].ok) { verdicts[a.k] = second[j]; first[a.k] = a.item; } else verdicts[a.k] = { ok: false, reason: second[j].reason || verdicts[a.k].reason };
      for (const [k, { x, i }] of generated.entries()) {
        if (verdicts[k].ok) { images.set(i, first[k].image); if (first[k].brief.recreation) x.label = "Recreación"; }
        else { x.card = first[k].brief.subject; x.reason = `Ilustración rechazada por la verificación (${verdicts[k].reason || "no muestra lo pedido"}): tarjeta con la idea del turno.`; }
        step("imagenes", ++doneUnits, units);
      }
      // Flujo anterior (pruebas con banco simulado o recreaciones explícitas).
      for (const { x, i } of imageShots.filter((e) => !generated.includes(e))) {
        const asset = pf.assets.find((a) => a.id === x.asset_id)!;
        const dest = path.join(ctx.dir, `img-${asset.id.replace(/[^\w-]/g, "_")}.png`);
        if (asset.kind === "recreacion" && ctx.providers.images.recreate) images.set(i, await pay(ctx.providers.images.name, "recreacion", { prompt: asset.query }, ctx.providers.images.recreateUsd ?? 0, async () => { const r = await ctx.providers.images.recreate!(asset.query, dest); return { result: dest, actualUsd: r.actualUsd }; }, dest));
        else if (ctx.providers.images.fetch) { await ctx.providers.images.fetch(asset, dest); images.set(i, dest); }
        step("imagenes", ++doneUnits, units);
      }
    }
    // 5) Avatares: un clip con lip-sync por aparición (de pago), recortado a la duración máxima.
    const frames = shotFrames(plan.shots, voice.duration);
    const avatarShots = plan.shots.map((x, i) => ({ x, i })).filter(({ x }) => isAvatarShot(x.kind));
    const clipOf = new Map<number, string>();
    if (avatarShots.length) step("avatares", 0, avatarShots.length);
    for (const [k, { x: shot, i }] of avatarShots.entries()) {
      const sp = shot.speaker!;
      const line = turnLine.get(shot.turn_id!)!;
      const secs = Math.min(frames[i] / FPS, line.end - line.start + 0.5);
      // Audio del tramo (desde el máster de voz) → el proveedor anima exactamente esa voz: sincronía labial con el máster.
      const seg = path.join(ctx.dir, `avatar-audio-${i}.wav`);
      await ffmpeg(["-y", "-v", "error", "-ss", (shot.start).toFixed(3), "-t", secs.toFixed(3), "-i", voice.file, "-c:a", "pcm_s16le", seg]);
      // Clave del clip: entradas deterministas (voz pagada del turno + tramo), no los bytes del máster (otra versión de
      // ffmpeg en otro runner daría otros bytes y se pagaría el mismo clip dos veces).
      const offset = Math.round((shot.start - line.start) * 1000) / 1000;
      const dest = path.join(ctx.dir, `avatar-${sp}-${i}.mp4`);
      const usd = ctx.providers.avatar.usdFor(secs);
      clipOf.set(i, await pay(ctx.providers.avatar.name, "avatar_clip", { avatar: avatarRef(spec, sp), tts: ttsKey.get(shot.turn_id!), offset, seconds: Math.round(secs * 1000) / 1000 }, usd, async () => { const r = await ctx.providers.avatar.render(prepared[sp] ?? avatarRef(spec, sp), seg, secs, dest, usd); return { result: dest, actualUsd: r.actualUsd }; }, dest));
      step("avatares", k + 1, avatarShots.length);
    }
    // 6) Montaje: recorte de cada persona (sin su fondo original) y composición en el estudio compartido.
    const fr = frameFor(spec.format, ctx.small);
    const matte = ctx.providers.matte ?? opaqueMatte;
    const stills: Partial<Record<"A" | "B", Matte>> = {};
    const stillMatte = async (s: "A" | "B") => {
      if (!stills[s]) { const f = path.join(ctx.dir, `still-${s}.png`); await ctx.providers.avatar.still(avatarRef(spec, s), f); stills[s] = await matte(f, path.join(ctx.dir, `recorte-quieto-${s}`), true); }
      return stills[s]!;
    };
    const clips: string[] = [];
    step("montaje", 0, plan.shots.length);
    for (const [i, shot] of plan.shots.entries()) {
      const line = shot.turn_id ? turnLine.get(shot.turn_id) : undefined;
      const words = spec.visual.subtitles && shot.turn_id && line ? (turnWords.get(shot.turn_id) ?? [])
        .map((w) => ({ text: w.text, start: line.start + w.start - shot.start, end: line.start + w.end - shot.start }))
        .filter((w) => w.end > 0 && w.start < shot.end - shot.start) : [];
      const src: Parameters<typeof renderShot>[4] = { title: spec.title, subtitle: spec.visual.subtitles && shot.turn_id ? turnText.get(shot.turn_id) ?? null : null, words: words.length ? words : undefined,
        image: images.get(i) ?? null, card: shot.card ?? null };
      if (isAvatarShot(shot.kind)) {
        const sp = shot.speaker!;
        src.speakerMatte = await matte(clipOf.get(i)!, path.join(ctx.dir, `recorte-${i}`), false);
        if (shot.kind === "two_shot") src.listenerMatte = await stillMatte(sp === "A" ? "B" : "A");
      }
      clips.push(await renderShot(ctx.dir, i, shot, frames[i], src, { set: spec.visual.set, frame: fr, swap: spec.visual.swap_sides, small: !!ctx.small, fade: true }));
      step("montaje", i + 1, plan.shots.length);
    }
    const mp4 = await muxEpisode(ctx.dir, clips, mix.master, path.join(ctx.dir, "episodio.mp4"), !!ctx.small);
    step("guardado", 0, 1);
    const durationSeconds = await ffprobeDuration(mp4);
    return { ok: true, mp4, audio: audioOut, durationSeconds, lufs: mix.lufs, truePeak: mix.truePeak, clipped: mix.clipped, musicTrack: mix.track?.file ?? null, mood: pf.mood, plan, timeline: voice.timeline,
      spentUsd: await committedUsd(ctx.ledger, ctx.episode), reusedOps: reused, paidOps: paid, charged: true, shotFiles: clips, providers: labels };
  } catch (e) {
    // No entregado: se liberan reservas sin liquidar; el usuario no consume cuota (charged nunca es true aquí).
    await releaseUndelivered(ctx.ledger, ctx.episode);
    throw e;
  } finally {
    await ctx.guard.release(ctx.episode, token);
  }
}

/** Copia de seguridad del exporte (para evidencia). */
export const copyOut = (src: string, dest: string) => copyFile(src, dest);
