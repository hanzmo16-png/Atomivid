/**
 * Podcast 3.0 — lógica de las rutas /api/podcast/v3 separada de Next (probada con dependencias simuladas).
 * Nada aquí llama a proveedores de pago: crear y estimar son gratis; autorizar solo registra el monto aprobado y
 * despacha el trabajo (la generación ocurre en el worker con el libro de operaciones).
 */
import { acceptedMinutes, scriptDuration } from "./duration";
import type { AccountVoice } from "@/lib/podcast/voices";
import type { VoiceViewer } from "@/lib/voices/private-voices";
import { StudioSpec, validateSpec, STUDIO_VERSION, type StudioSpec as Spec } from "./spec";
import { isPrivateVoice } from "@/lib/voices/private-voices";
import { preflight, type ImageProvider, type Providers, type VisualDirector } from "./pipeline";
import { RECRAFT_USD_PER_IMAGE, RECRAFT_USD_STYLE_CREATION } from "@/lib/providers/image/recraft";
import { generateConversation, type LlmFn } from "./script";
import { advanceLongScript, assembleLongScript, checkLongState, LONG_SCRIPT_MAX_MINUTES, LongScriptError, newLongScript, normalizeLongInput, sameLongInput, segmentCount, type LlmStepFn, type LongScriptState } from "./long-script";
import { estimateHeygenCost } from "@/lib/providers/avatar/heygen";
import { getPricingConfig } from "@/lib/billing/pricing";
import type { StudioEpisodeRow } from "./store";
import { ledgerActivity, type LedgerOp } from "./progress";
import { requireProvider, ProviderUnavailableError, visualProviders, lipTimeline, shotCoverage } from "./studio";

/** Proveedores de PLANIFICACIÓN (sin red, sin costo): solo para estimar; nunca generan medios. */
export function planningProviders(): Providers {
  const rate = getPricingConfig().elevenLabsUsdPer1kChars;
  // Ilustraciones de Recraft (una por plano de imagen) y director visual: solo sus tarifas, nunca se llaman al estimar.
  const images: ImageProvider = { name: "plan", label: "mock", generateUsd: RECRAFT_USD_PER_IMAGE, styleUsd: RECRAFT_USD_STYLE_CREATION, async generate() { throw new Error("solo planificación"); } };
  // Director visual local (CLIP en el generador): sin costo, pero su línea aparece en la estimación.
  const director: VisualDirector = { name: "clip", label: "mock", briefUsd: 0, verifyUsd: 0, verifyBatchUsd: 0, async brief() { throw new Error("solo planificación"); }, async verify() { throw new Error("solo planificación"); } };
  return { images, director,
    tts: { name: "plan", label: "mock", model: "eleven_multilingual_v2", usdFor: (n) => Math.ceil(n / 1000 * rate * 1e4) / 1e4, async synth() { throw new Error("solo planificación"); } },
    avatar: { name: "plan", label: "mock", usdFor: (s) => estimateHeygenCost(Math.max(1, s)), async render() { throw new Error("solo planificación"); }, async still() { throw new Error("solo planificación"); } } };
}

export type ApiDeps = {
  userId: string; viewer: VoiceViewer; voices: () => Promise<AccountVoice[]>; enabled: boolean; llm: LlmFn | null;
  /** Guion largo por segmentos: modelo para el trabajo `jobId` (clave determinista por paso). null = IA no disponible. */
  llmStep?: ((jobId: string) => LlmStepFn) | null;
  newJobId?: () => string;
  /** USD de guion con IA de esta persona en las últimas 24 h (libro de gastos). Lanza si no se puede leer (falla cerrado). */
  scriptSpend?: () => Promise<number>;
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
  /** Motivo por el que Recraft no puede producir hoy (null = listo). Solo lectura; sin él no se comprueba. */
  recraftBlocker?: () => Promise<string | null>;
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
    const minutes = Math.min(LONG_SCRIPT_MAX_MINUTES, Math.max(1, Number(b.minutes) || 5));
    const host = String(b.hostName ?? "Anfitrión").slice(0, 60) || "Anfitrión", guest = String(b.guestName ?? "Invitado").slice(0, 60) || "Invitado";
    // Guion con IA: solo por pasos («script-step»), con errores claros. Una página antigua que aún pida la IA aquí recibe
    // un aviso en vez de la plantilla (P0 2026-11-01: «El modelo no respondió; se usó la plantilla» para 30 min pedidos).
    if (b.useAi === true) return { status: 409, body: { error: "Actualiza la página: la conversación con IA ahora se escribe por bloques.", code: "ACTUALIZAR" } };
    // Plantilla breve gratuita, solo cuando la persona la elige expresamente: su nota dice cuánto dura de verdad.
    const r = await generateConversation({ topic, hostName: host, guestName: guest, guestRole: String(b.guestRole ?? "").slice(0, 120), minutes, hostPersonality: String(b.hostPersonality ?? "").slice(0, 160), guestPersonality: String(b.guestPersonality ?? "").slice(0, 160) }, null);
    const names = { A: host, B: guest };
    return { status: 200, body: { script: r.turns.map((t) => `${names[t.speaker]}: ${t.text}`).join("\n"), source: r.source, note: r.note ?? null, turns: r.turns.length } };
  }
  if (b.action === "script-step") return scriptStepAction(d, b);
  const parsed = StudioSpec.safeParse({ ...((b.spec as object) ?? {}), version: STUDIO_VERSION });
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Datos inválidos.", path: parsed.error.issues[0]?.path } };
  const spec: Spec = parsed.data;
  // Proveedor visual elegido: si no está disponible se rechaza con el motivo; nunca se sustituye en silencio.
  const recraftBlock = d.recraftBlocker ? await d.recraftBlocker() : null;
  try { requireProvider(spec.visual.provider, d.env ?? process.env, recraftBlock); } catch (e) { if (e instanceof ProviderUnavailableError) return { status: 409, body: { error: e.message, provider: spec.visual.provider } }; throw e; }
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
  const pf = await preflight(stored, planningProviders());
  const estimate = { lines: pf.estimate.lines, totalUsd: pf.estimate.totalUsd, assumptions: pf.estimate.assumptions, rates: pf.estimate.rates, turns: pf.turns.length, mood: pf.mood,
    shots: pf.plan.shots.reduce<Record<string, number>>((m, s) => ({ ...m, [s.kind]: (m[s.kind] ?? 0) + 1 }), {}), overBudget: pf.estimate.totalUsd > spec.budget_usd,
    byProvider: pf.estimate.lines.reduce<Record<string, number>>((m, l) => ({ ...m, [l.provider]: Math.round(((m[l.provider] ?? 0) + l.usd) * 1e4) / 1e4 }), {}),
    providers: visualProviders(d.env ?? process.env, recraftBlock), lipTimeline: lipTimeline(pf.plan).slice(0, 40), coverage: shotCoverage(pf.plan),
    turnList: pf.turns.slice(0, 60).map((t) => ({ id: t.id, speaker: t.speaker, kind: t.kind, text: t.text.slice(0, 140) })),
    // Duración estimada del guion frente a la pedida (incidente 8f05fc37): la pantalla Producir la muestra antes de cobrar.
    duration: scriptDuration(stored) };
  if (b.action === "estimate") return { status: 200, body: { estimate } };
  if (b.action === "create") {
    if (!d.enabled) return DISABLED;
    if (estimate.overBudget) return { status: 402, body: { error: `El costo estimado (USD ${estimate.totalUsd.toFixed(2)}) supera tu presupuesto máximo (USD ${spec.budget_usd.toFixed(2)}). Sube el presupuesto o reduce apariciones del avatar.`, estimate } };
    // Episodio largo cuyo guion no alcanza lo pedido: no se promete una duración que no cabe. Sin aceptar la duración real
    // no se crea; al aceptarla, lo prometido (target_minutes) pasa a ser lo que el guion da y se guarda lo que se pidió.
    let toStore = stored;
    if (estimate.duration.needsAcceptance) {
      if (b.acceptDuration !== true) return { status: 409, body: { error: `${estimate.duration.message} Alarga el guion en «Contenido» o acepta esa duración para continuar.`, code: "DURACION", duration: estimate.duration } };
      toStore = { ...stored, requested_minutes: stored.target_minutes, target_minutes: acceptedMinutes(estimate.duration) };
    }
    const row = await d.insert({ user_id: d.userId, title: toStore.title, mode: toStore.mode, spec: toStore, status: "draft", estimate, estimated_usd: estimate.totalUsd });
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
  // «Sin arranque» = ningún worker tomó el episodio DESPUÉS de esta autorización (un reintento tras un fallo conserva
  // la marca del intento anterior, más antigua que authorized_at).
  const notStarted = !row.run_started_at || (!!row.authorized_at && Date.parse(row.run_started_at) < Date.parse(row.authorized_at));
  if (row.status === "authorized" && notStarted) {
    if (body?.confirm !== true) return { status: 400, body: { error: "Confirma explícitamente el costo antes de generar." } };
    const dispatched = await d.dispatch(id);
    return { status: 200, body: { ok: true, dispatched, note: dispatched ? null : "Autorizado. No pudimos confirmar el inicio del trabajo; pulsa «Reintentar» (no se cobra dos veces)." } };
  }
  if (row.status !== "draft" && row.status !== "failed") return { status: 409, body: { error: row.status === "generating" || row.status === "authorized" ? "Ya se está generando; no se inicia otra vez." : "Este episodio ya fue autorizado." } };
  if (body?.confirm !== true) return { status: 400, body: { error: "Confirma explícitamente el costo antes de generar." } };
  const usd = Number(body?.authorizedUsd);
  const spec = StudioSpec.safeParse(row.spec);
  if (!spec.success) return { status: 409, body: { error: "Especificación del episodio inválida." } };
  // Un borrador que promete una duración larga que su guion no alcanza (creado antes de esta regla) no se cobra.
  const dur = scriptDuration(spec.data);
  if (dur.needsAcceptance) return { status: 409, body: { error: `${dur.message} Vuelve a «Producir» para aceptar esa duración o alarga el guion.`, code: "DURACION", duration: dur } };
  if (!Number.isFinite(usd) || usd < Number(row.estimated_usd ?? 0) - 1e-9) return { status: 402, body: { error: "El monto autorizado es menor que la estimación." } };
  if (usd > spec.data.budget_usd + 1e-9) return { status: 402, body: { error: "El monto autorizado supera el presupuesto máximo del episodio." } };
  // Tope duro por autorización (independiente del presupuesto que escriba el usuario): un error o un abuso no puede
  // autorizar más de STUDIO_MAX_AUTHORIZED_USD por episodio.
  if (usd > STUDIO_MAX_AUTHORIZED_USD + 1e-9) return { status: 402, body: { error: `Por seguridad, un episodio no puede autorizar más de USD ${STUDIO_MAX_AUTHORIZED_USD}.` } };
  // Recraft no listo (política o saldo): se rechaza ANTES de autorizar; el borrador queda intacto y nada se cobra.
  if (spec.data.visual.provider === "recraft" && d.recraftBlocker) {
    try { requireProvider("recraft", d.env ?? process.env, await d.recraftBlocker()); }
    catch (e) { if (e instanceof ProviderUnavailableError) return { status: 409, body: { error: e.message, provider: "recraft" } }; throw e; }
  }
  if (!(await d.authorize(id, usd))) return { status: 409, body: { error: "Otra solicitud cambió el episodio; recarga la página." } };
  const dispatched = await d.dispatch(id);
  return { status: 200, body: { ok: true, dispatched, note: dispatched ? null : "Autorizado. No pudimos confirmar el inicio del trabajo; pulsa «Reintentar» (no se cobra dos veces)." } };
}

/**
 * Archivo de entrega del propio episodio. El prefijo no basta: `..`, `.`, un segmento vacío o una ruta codificada
 * salen de `${userId}/podcast-studio/${episodeId}/` y no se firman.
 */
export function ownStudioAsset(userId: string, episodeId: string, p: string | null): boolean {
  if (!p || p.includes("\\") || p.includes("\0")) return false;
  let decoded: string;
  try { decoded = decodeURIComponent(p); } catch { return false; }
  if (decoded !== p || decoded.includes("\\") || decoded.includes("\0")) return false;
  const prefix = `${userId}/podcast-studio/${episodeId}/`;
  if (!decoded.startsWith(prefix)) return false;
  const rest = decoded.slice(prefix.length);
  return rest.length > 0 && rest.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * GET del episodio de estudio (estado + enlaces de descarga firmados). Solo el dueño; solo rutas dentro de su carpeta
 * del episodio; enlaces solo cuando está «ready». Solo audio no firma MP4. Separado de Next para probar aislamiento
 * y descarga sin red.
 */
export async function episodeAction(userId: string, row: StudioEpisodeRow | "missing" | null, sign: (path: string, name: string) => Promise<string | null>,
  /** Operaciones del libro del episodio (solo mientras se produce): la actividad real, resumida; nunca filas crudas. */
  ops?: () => Promise<LedgerOp[] | null>): Promise<Out> {
  if (row === "missing") return { status: 503, body: { error: "Requiere la migración del estudio." } };
  if (!row || row.user_id !== userId) return { status: 404, body: { error: "Episodio no encontrado." } };
  const audioOnly = (() => { const s = StudioSpec.safeParse(row.spec); return s.success && s.data.output === "audio"; })();
  const signOwn = async (p: string | null, name: string) => (!p || !ownStudioAsset(userId, row.id, p) ? null : sign(p, name));
  const { spec: _spec, ...pub } = row;
  const activity = ops && (row.status === "generating" || row.status === "authorized") ? await ops().then((x) => (x ? ledgerActivity(x) : null)).catch(() => null) : null;
  // Duración entregada frente a la pedida (registrada por el generador): visible, nunca silenciosa.
  const dc = (row.result as { duration_check?: { ok?: boolean; note?: string | null } } | null)?.duration_check;
  const durationNote = row.status === "ready" && dc && dc.ok === false ? dc.note ?? null : null;
  return { status: 200, body: { episode: { ...pub, output: audioOnly ? "audio" : "video" }, activity, duration_note: durationNote, video_url: row.status === "ready" && !audioOnly ? await signOwn(row.video_path, `${row.title}.mp4`) : null,
    audio_url: row.status === "ready" ? await signOwn(row.audio_path, `${row.title}.${row.audio_path?.split(".").pop() ?? "mp3"}`) : null } };
}

/** Tope diario de guion con IA por persona (USD en 24 h; PODCAST_SCRIPT_DAILY_USD, 3 por defecto, entre 0,5 y 50). */
export function scriptDailyCapUsd(env: Record<string, string | undefined>): number {
  const v = Number(env.PODCAST_SCRIPT_DAILY_USD);
  return Number.isFinite(v) && v > 0 ? Math.min(50, Math.max(0.5, v)) : 3;
}

/**
 * Error del modelo o del control de gasto → mensaje claro y recuperable (nunca plantilla). `detail` es un código corto
 * para soporte: sin claves, montos de otras cuentas ni texto del proveedor más allá del motivo.
 */
export function describeLlmFailure(e: unknown): { status: number; error: string; detail: string } {
  const err = e as { name?: string; message?: string; status?: number; reason?: string };
  const name = String(err?.name ?? ""), msg = String(err?.message ?? "");
  if (name === "SupplyUnavailableError" || msg.startsWith("SUPPLY_UNAVAILABLE:")) {
    const reason = msg.split(":").slice(2).join(":") || String(err.reason ?? "");
    const human: Record<string, string> = {
      "concurrency": "otra generación con IA está en curso en la plataforma",
      "daily request quota": "se alcanzó el número máximo de llamadas de IA del día",
      "provider funded spend ceiling": "se alcanzó el tope de gasto de IA del día o del mes",
      "global funded spend ceiling": "se alcanzó el tope de gasto global del día o del mes",
      "insufficient unreserved balance": "el saldo registrado del proveedor de IA no alcanza",
      "balance unverified or stale": "el saldo del proveedor de IA no está verificado",
      "policy unconfigured": "el control de gasto del proveedor de IA no está configurado",
      "funded global budget unconfigured": "el presupuesto global no está configurado",
      "previous consumption requires reconciliation": "una llamada anterior de este trabajo quedó sin confirmar",
      "new work paused": "el saldo del proveedor de IA está en nivel crítico",
      "supplier unavailable": "el proveedor de IA no está disponible",
      "control unavailable": "no se pudo consultar el control de gasto",
      "authorization missing": "falta la autorización de gasto de este proyecto",
      "authorization owner mismatch": "la autorización de gasto no corresponde a este proyecto",
      "authorization exceeded": "se alcanzó el tope autorizado de este proyecto",
      "job envelope exhausted": "se agotó el presupuesto reservado del trabajo",
    };
    return { status: 503, error: `La IA no pudo empezar: ${human[reason] ?? "el control de gasto no admitió la llamada"}. No se cobró nada y lo ya escrito se conserva; reintenta en unos minutos.`, detail: `supply:${reason.slice(0, 60)}` };
  }
  if (name === "SubmissionInFlightError") return { status: 409, error: "Ese paso ya se está generando (¿otra pestaña?). Espera un momento y reintenta: no se paga dos veces.", detail: "in-flight" };
  if (/Reconciliation/i.test(name)) return { status: 409, error: "Una llamada de este guion quedó sin confirmar con el proveedor; por seguridad no se repite. Empieza un guion nuevo.", detail: "reconciliation" };
  if (name === "PaidLedgerUnavailableError" || name === "ScriptLedgerUnavailableError") return { status: 503, error: "No se pudo registrar el gasto de la llamada; no se llamó a la IA. Reintenta en unos minutos.", detail: "ledger" };
  if (typeof err?.status === "number") return { status: 502, error: `El modelo respondió con un error (${err.status}). No se usó ninguna plantilla; lo ya escrito se conserva y puedes reintentar.`, detail: `provider:${err.status}` };
  return { status: 502, error: "El modelo no respondió. No se usó ninguna plantilla; lo ya escrito se conserva y puedes reintentar.", detail: `error:${name.slice(0, 40) || "desconocido"}` };
}

/**
 * Un paso del guion con IA (escaleta o siguiente segmento). El navegador guarda el estado y llama otra vez hasta `done`.
 * Sin IA disponible responde un error claro: la plantilla breve solo se usa si la persona la elige expresamente.
 */
async function scriptStepAction(d: ApiDeps, b: Record<string, unknown>): Promise<Out> {
  const input = normalizeLongInput(b);
  if (input.topic.length < 3) return { status: 400, body: { error: "Escribe un tema de al menos 3 caracteres." } };
  const { minutes } = input;
  if (!d.enabled || !d.llmStep) return { status: 503, body: { error: "La generación con IA no está disponible en este momento. No se usó ninguna plantilla: puedes escribir o pegar tu guion, o elegir expresamente la plantilla breve.", code: "IA_NO_DISPONIBLE" } };
  let state: LongScriptState;
  try {
    // Un trabajo guardado de OTRO tema, nombres o duración no se continúa: se empieza uno nuevo.
    const prev = b.state as LongScriptState | null | undefined;
    const same = !!prev && sameLongInput(prev.input, input);
    state = same ? checkLongState(prev, input) : newLongScript((d.newJobId ?? (() => crypto.randomUUID()))(), input);
  } catch (e) {
    if (e instanceof LongScriptError) return { status: 400, body: { error: e.message, code: e.code, recoverable: false } };
    throw e;
  }
  // Tope diario por persona (además de los topes global y del proveedor): el guion se escribe antes de que exista un
  // episodio, así que no hay autorización por episodio que lo acote. Sin lectura del libro, no se llama a la IA.
  const cap = scriptDailyCapUsd(d.env ?? process.env);
  if (d.scriptSpend) {
    let used: number;
    try { used = await d.scriptSpend(); } catch { return { status: 503, body: { error: "No se pudo comprobar tu gasto de IA de hoy; no se llamó a la IA. Reintenta en unos minutos.", code: "IA_FALLO", recoverable: true, state } }; }
    if (used >= cap) return { status: 429, body: { error: `Alcanzaste el límite diario de guiones con IA (USD ${cap.toFixed(2)} en 24 h). Lo ya escrito se conserva; podrás continuar más tarde.`, code: "LIMITE_DIARIO", recoverable: true, state } };
  }
  try {
    const r = await advanceLongScript(state, d.llmStep(state.jobId));
    const base = { state: r.state, step: r.step, steps: r.steps, segments: segmentCount(minutes), phase: r.phase, ...(r.note ? { stepNote: r.note } : {}) };
    if (!r.done) return { status: 200, body: { ...base, done: false } };
    const final = assembleLongScript(r.state);
    const names = { A: input.hostName, B: input.guestName };
    const est = String(final.estimatedMinutes).replace(".", ",");
    return { status: 200, body: { ...base, done: true, script: final.turns.map((t) => `${names[t.speaker]}: ${t.text}`).join("\n"), turns: final.turns.length,
      estimatedMinutes: final.estimatedMinutes, withinTarget: final.withinTarget, source: "llm",
      note: final.withinTarget ? `Conversación original generada con IA en ${r.steps - 1} bloques: unos ${est} min para ${minutes} pedidos. Revísala antes de seguir.`
        : `La conversación generada dura unos ${est} min y pediste ${minutes}: no se rellenó. Puedes alargarla, generar de nuevo o aceptar esa duración al producir.` } };
  } catch (e) {
    if (e instanceof LongScriptError) {
      const kept = (e as LongScriptError & { state?: LongScriptState }).state ?? state;
      return { status: e.code === "AGOTADO" ? 409 : 422, body: { error: e.message, code: e.code, recoverable: e.recoverable, state: kept, step: kept.segments.length + (kept.plan ? 1 : 0), steps: 1 + segmentCount(minutes) } };
    }
    const f = describeLlmFailure(e);
    console.error("podcast-studio script-step", { job: state.jobId, step: state.plan ? `s${state.segments.length}` : "plan", detail: f.detail });
    return { status: f.status, body: { error: f.error, code: "IA_FALLO", detail: f.detail, recoverable: f.detail !== "reconciliation", state, step: state.segments.length + (state.plan ? 1 : 0), steps: 1 + segmentCount(minutes) } };
  }
}
