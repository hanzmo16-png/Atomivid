/**
 * Podcast — avance de la producción del estudio (puro: worker, API y UI).
 *
 * El porcentaje sale del TRABAJO COMPLETADO, no de un reloj: cada etapa real (preparación, voces, imágenes, avatares,
 * montaje, guardado) tiene un peso aproximado de su duración y, dentro de ella, avanza por unidades terminadas
 * (turnos con voz, imágenes listas, clips de avatar recibidos, planos montados). Es una ESTIMACIÓN POR ETAPAS y así se
 * muestra. Las etapas que el episodio no tiene (solo audio: sin imágenes, avatares ni montaje) no cuentan.
 * Nunca llega a 100 % antes de que el resultado esté guardado y disponible (eso lo marca el estado «ready»).
 */
export const STAGES = ["preparacion", "voces", "imagenes", "avatares", "montaje", "guardado"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABEL: Record<Stage, string> = {
  preparacion: "Preparación", voces: "Voces", imagenes: "Imágenes", avatares: "Avatares", montaje: "Montaje", guardado: "Guardado",
};
/** Peso de cada etapa (proporcional a su duración habitual: los clips de avatar son la parte larga). */
const WEIGHT: Record<Stage, number> = { preparacion: 3, voces: 15, imagenes: 12, avatares: 42, montaje: 23, guardado: 5 };

/** Hito durable de una etapa: unidades terminadas y cuándo se informó por última vez. */
export type Milestone = { done: number; total: number; at: string };
/** Entrada de actividad reciente (texto ya legible para el dueño). */
export type Activity = { at: string; text: string };
export type StudioProgress = { stage: Stage; pct: number; done: number; total: number; estimate: true; updatedAt: string;
  /** Hitos por etapa (se conservan aunque la etapa ya pasó: al volver a abrir la página se ve lo hecho). */
  stages?: Partial<Record<Stage, Milestone>>;
  /** Últimos avances (más reciente al final, máximo ACTIVITY_MAX). */
  activity?: Activity[] };
export const ACTIVITY_MAX = 6;

/** Etapas que aplican según lo que el episodio produce. */
export function stagesFor(o: { video: boolean; images: boolean; avatars: boolean }): Stage[] {
  return STAGES.filter((s) => (s === "imagenes" ? o.video && o.images : s === "avatares" ? o.video && o.avatars : s === "montaje" ? o.video : true));
}

/** Porcentaje (0–99) con la etapa `stage` en `done` de `total` unidades. */
export function progressPct(stages: readonly Stage[], stage: Stage, done: number, total: number): number {
  const sum = stages.reduce((n, s) => n + WEIGHT[s], 0) || 1;
  let before = 0;
  for (const s of stages) { if (s === stage) break; before += WEIGHT[s]; }
  const frac = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  const w = stages.includes(stage) ? WEIGHT[stage] : 0;
  return Math.min(99, Math.floor(((before + w * frac) / sum) * 100));
}

export function progressRecord(stages: readonly Stage[], stage: Stage, done: number, total: number, now = new Date()): StudioProgress {
  return { stage, pct: progressPct(stages, stage, done, total), done, total, estimate: true, updatedAt: now.toISOString() };
}

const UNIT: Record<Stage, string> = { preparacion: "Preparación lista", voces: "Voz", imagenes: "Imagen", avatares: "Clip de avatar", montaje: "Plano montado", guardado: "Guardando el archivo final" };
function activityText(stage: Stage, done: number, total: number): string {
  if (stage === "preparacion" || stage === "guardado") return UNIT[stage];
  return done === 0 ? `Empieza: ${STAGE_LABEL[stage]} (${total})` : `${UNIT[stage]} ${done} de ${total}`;
}

/**
 * Une el avance anterior con el nuevo SIN RETROCEDER: el porcentaje y la etapa solo avanzan (un informe tardío o
 * repetido no baja la barra), los hitos de cada etapa guardan el máximo de unidades terminadas y la actividad suma una
 * entrada por cada avance real (no por latido). Nunca pasa de 99: el 100 % lo da solo el estado «ready».
 */
export function mergeProgress(prev: StudioProgress | null, next: StudioProgress): StudioProgress {
  const stages: Partial<Record<Stage, Milestone>> = { ...(prev?.stages ?? {}) };
  const old = stages[next.stage];
  const advanced = !old || next.done > old.done || next.total !== old.total;
  stages[next.stage] = { done: Math.max(old?.done ?? 0, next.done), total: next.total, at: next.updatedAt };
  const activity = [...(prev?.activity ?? [])];
  if (advanced) activity.push({ at: next.updatedAt, text: activityText(next.stage, next.done, next.total) });
  const behind = !!prev && (STAGES.indexOf(next.stage) < STAGES.indexOf(prev.stage) || (next.stage === prev.stage && next.done < prev.done));
  const head = behind ? { stage: prev!.stage, done: prev!.done, total: prev!.total } : { stage: next.stage, done: next.done, total: next.total };
  return { ...head, pct: Math.min(99, Math.max(prev?.pct ?? 0, next.pct)), estimate: true, updatedAt: next.updatedAt, stages, activity: activity.slice(-ACTIVITY_MAX) };
}

/**
 * Actividad leída del libro de operaciones del estudio (cada llamada a un proveedor queda registrada ANTES de hacerse).
 * Es la prueba independiente de que el procesador trabaja, aunque el avance guardado falte o sea viejo.
 */
export type LedgerOp = { provider: string; op: string; state: string; created_at: string; updated_at?: string | null };
export type LedgerActivity = { lastAt: string | null; counts: Partial<Record<Stage, number>>; stage: Stage | null; recent: Activity[] };
const OP_STAGE: Record<string, Stage> = { avatar_prepare: "preparacion", tts: "voces", guion_visual: "imagenes", ilustracion: "imagenes", verificacion: "imagenes", avatar_clip: "avatares" };
const OP_TEXT: Record<string, [string, string]> = {
  avatar_prepare: ["Preparando avatar", "Avatar preparado"], tts: ["Generando voz", "Voz lista"], guion_visual: ["Planeando imágenes", "Imágenes planeadas"],
  ilustracion: ["Generando ilustración", "Ilustración lista"], verificacion: ["Verificando imágenes", "Imágenes verificadas"], avatar_clip: ["Generando clip de avatar", "Clip de avatar listo"],
};
/** Unidades que cuenta cada etapa (las de apoyo, como la verificación, no suman unidades). */
const COUNTED = new Set(["tts", "ilustracion", "avatar_clip"]);
export function ledgerActivity(ops: readonly LedgerOp[]): LedgerActivity {
  const at = (o: LedgerOp) => (o.updated_at && Date.parse(o.updated_at) > Date.parse(o.created_at) ? o.updated_at : o.created_at);
  const live = ops.filter((o) => o.state !== "released" && OP_STAGE[o.op]);
  const counts: Partial<Record<Stage, number>> = {};
  for (const o of live) if (COUNTED.has(o.op) && o.state === "settled") counts[OP_STAGE[o.op]] = (counts[OP_STAGE[o.op]] ?? 0) + 1;
  const sorted = [...live].sort((a, b) => Date.parse(at(a)) - Date.parse(at(b)));
  const stage = sorted.reduce<Stage | null>((s, o) => (s && STAGES.indexOf(s) >= STAGES.indexOf(OP_STAGE[o.op]) ? s : OP_STAGE[o.op]), null);
  const recent = sorted.slice(-ACTIVITY_MAX).map((o) => {
    const [doing, done] = OP_TEXT[o.op];
    const n = COUNTED.has(o.op) ? ` ${sorted.filter((x) => x.op === o.op && Date.parse(at(x)) <= Date.parse(at(o))).length}` : "";
    return { at: at(o), text: `${o.state === "settled" ? done : doing}${n}` };
  });
  return { lastAt: sorted.length ? at(sorted[sorted.length - 1]) : null, counts, stage, recent };
}

/** Nombres de etapa de versiones anteriores del worker («voz», «musica», «video», «listo»). */
const LEGACY: Record<string, Stage> = { voz: "voces", musica: "voces", video: "montaje", listo: "guardado" };

export type StageRow = { stage: Stage; label: string; state: "hecha" | "activa" | "pendiente"; done: number | null; total: number | null };
export type ProgressView = {
  state: "espera" | "procesando" | "sin_informacion" | "error" | "listo";
  pct: number; stage: Stage | null; stageLabel: string; detail: string | null; title: string; active: boolean;
  /** Etapas del episodio con sus hitos (lo hecho se conserva al volver a abrir la página). */
  stages: StageRow[];
  /** Última señal real del procesador (avance guardado o una operación del libro) y los últimos avances. */
  lastActivityAt: string | null; recent: Activity[];
};
/** Sin ninguna actualización durante este tiempo, se avisa de que falta información (sin inventar avance). */
export const STALE_MS = 10 * 60_000;

type EpisodeLike = { status: string; progress?: unknown; updated_at?: string | null; error?: string | null; audio_path?: string | null; video_path?: string | null;
  /** Salida del episodio: sin video no hay imágenes, avatares ni montaje. */
  output?: "audio" | "video" | null };

/**
 * Lo que la UI muestra a partir del estado guardado y, si se da, de la actividad del libro de operaciones. «En espera»
 * solo mientras NINGÚN procesador tomó el episodio («authorized»); en cuanto empieza («generating») se muestra la etapa
 * real. Si el avance guardado falta o se quedó atrás, el libro pone un mínimo comprobable (la etapa de la última
 * operación y las unidades ya liquidadas), nunca un porcentaje inventado. «Listo» (100 %) exige el archivo guardado.
 */
export function progressView(ep: EpisodeLike, now = Date.now(), ledger?: LedgerActivity | null): ProgressView {
  const raw = (ep.progress && typeof ep.progress === "object" ? ep.progress : {}) as { stage?: string; pct?: number; done?: number; total?: number; updatedAt?: string; stages?: Partial<Record<string, Milestone>>; activity?: Activity[] };
  const norm = (x?: string) => (x && ((STAGES as readonly string[]).includes(x) ? x : LEGACY[x])) as Stage | undefined;
  const saved = norm(raw.stage);
  const video = ep.output !== "audio";
  const applicable = stagesFor({ video, images: video, avatars: video });
  const savedIdx = saved ? STAGES.indexOf(saved) : -1;
  const ledgerIdx = ledger?.stage ? STAGES.indexOf(ledger.stage) : -1;
  const stage = (ledgerIdx > savedIdx ? ledger!.stage! : saved) ?? undefined;
  const ledgerPct = ledger?.stage ? progressPct(applicable, ledger.stage, 0, 1) : 0;
  const pct = Math.max(0, Math.min(99, Math.max(Math.floor(Number(raw.pct) || 0), ledgerIdx > savedIdx ? ledgerPct : 0)));
  const ms = (s: Stage) => { const m = raw.stages?.[s] ?? Object.entries(raw.stages ?? {}).find(([k]) => LEGACY[k] === s)?.[1]; return m && Number(m.total) > 0 ? m : null; };
  const curIdx = stage ? STAGES.indexOf(stage) : -1;
  const rows: StageRow[] = applicable.map((s) => {
    const m = ms(s);
    const fromLedger = ledger?.counts[s] ?? null;
    const total = s === saved && Number(raw.total) > 0 ? Number(raw.total) : m ? Number(m.total) : null;
    const doneSaved = s === saved && Number(raw.total) > 0 ? Number(raw.done) || 0 : m ? Number(m.done) || 0 : null;
    const done = doneSaved == null && fromLedger == null ? null : Math.max(doneSaved ?? 0, fromLedger ?? 0);
    const idx = STAGES.indexOf(s);
    return { stage: s, label: STAGE_LABEL[s], state: idx < curIdx ? "hecha" : idx === curIdx ? "activa" : "pendiente", done: total != null && done != null ? Math.min(done, total) : done, total };
  });
  const cur = rows.find((r) => r.stage === stage);
  const detail = cur && cur.done != null ? (cur.total != null ? `${cur.done} de ${cur.total}` : `${cur.done} listas`) : null;
  const times = [raw.updatedAt, ledger?.lastAt, ep.updated_at].map((t) => Date.parse(t ?? "")).filter(Number.isFinite);
  const lastMs = times.length ? Math.max(...times) : NaN;
  const lastActivityAt = Number.isFinite(lastMs) ? new Date(lastMs).toISOString() : null;
  const recent = [...(raw.activity ?? []), ...(ledger?.recent ?? [])].filter((a) => a && Number.isFinite(Date.parse(a.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).filter((a, i, all) => i === 0 || a.text !== all[i - 1].text || a.at !== all[i - 1].at).slice(-ACTIVITY_MAX);
  const base = { stages: rows, lastActivityAt, recent };
  if (ep.status === "ready" && (ep.audio_path === undefined || !!ep.audio_path)) return { ...base, stages: rows.map((r) => ({ ...r, state: "hecha" as const })), state: "listo", pct: 100, stage: "guardado", stageLabel: "Listo", detail: null, title: "Tu episodio está listo", active: false };
  if (ep.status === "failed") return { ...base, state: "error", pct, stage: stage ?? null, stageLabel: stage ? STAGE_LABEL[stage] : "—", detail: null, title: "No se pudo terminar", active: false };
  if (ep.status === "authorized" || ep.status === "draft") return { ...base, state: "espera", pct: 0, stage: null, stageLabel: "En espera", detail: null, title: "Esperando a que un procesador tome tu episodio", active: true };
  // «ready» sin archivo (no debería ocurrir) o «generating»: nunca 100 %.
  const stale = Number.isFinite(lastMs) && now - lastMs > STALE_MS;
  if (stale) return { ...base, state: "sin_informacion", pct, stage: stage ?? null, stageLabel: stage ? STAGE_LABEL[stage] : "Procesando", detail, title: "El procesador no responde desde hace un rato", active: false };
  return { ...base, state: "procesando", pct, stage: stage ?? "preparacion", stageLabel: STAGE_LABEL[stage ?? "preparacion"], detail, title: "Produciendo tu episodio", active: true };
}

/** «hace 3 min» para la última actividad (sin segundos: la página consulta cada pocos segundos). */
export function ago(at: string | null, now = Date.now()): string | null {
  const t = Date.parse(at ?? "");
  if (!Number.isFinite(t)) return null;
  const min = Math.max(0, Math.floor((now - t) / 60_000));
  return min < 1 ? "hace menos de 1 min" : min < 60 ? `hace ${min} min` : `hace ${Math.floor(min / 60)} h ${min % 60} min`;
}

/** Mensajes discretos por etapa (no prometen tiempos). */
export function stageMessage(stage: Stage | null): string | null {
  if (stage === "voces") return "Estamos dando voz a tu episodio";
  if (stage === "imagenes") return "Preparando las imágenes de tu historia";
  if (stage === "avatares" || stage === "montaje") return "Puedes disfrutar un café mientras seguimos trabajando";
  return null;
}
