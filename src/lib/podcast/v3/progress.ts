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

export type StudioProgress = { stage: Stage; pct: number; done: number; total: number; estimate: true; updatedAt: string };

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

/** Nombres de etapa de versiones anteriores del worker («voz», «musica», «video», «listo»). */
const LEGACY: Record<string, Stage> = { voz: "voces", musica: "voces", video: "montaje", listo: "guardado" };

export type ProgressView = {
  state: "espera" | "procesando" | "sin_informacion" | "error" | "listo";
  pct: number; stage: Stage | null; stageLabel: string; detail: string | null; title: string; active: boolean;
};
/** Sin ninguna actualización durante este tiempo, se avisa de que falta información (sin inventar avance). */
export const STALE_MS = 10 * 60_000;

/**
 * Lo que la UI muestra a partir del estado guardado. «En espera» solo mientras NINGÚN procesador tomó el episodio
 * («authorized»); en cuanto empieza («generating») se muestra la etapa real.
 */
export function progressView(ep: { status: string; progress?: unknown; updated_at?: string | null; error?: string | null }, now = Date.now()): ProgressView {
  const raw = (ep.progress && typeof ep.progress === "object" ? ep.progress : {}) as { stage?: string; pct?: number; done?: number; total?: number; updatedAt?: string };
  const stage = (raw.stage && ((STAGES as readonly string[]).includes(raw.stage) ? raw.stage : LEGACY[raw.stage])) as Stage | undefined;
  const pct = Math.max(0, Math.min(99, Math.floor(Number(raw.pct) || 0)));
  const detail = stage && Number(raw.total) > 0 ? `${Math.min(Number(raw.done) || 0, Number(raw.total))} de ${raw.total}` : null;
  if (ep.status === "ready") return { state: "listo", pct: 100, stage: "guardado", stageLabel: "Listo", detail: null, title: "Tu episodio está listo", active: false };
  if (ep.status === "failed") return { state: "error", pct, stage: stage ?? null, stageLabel: stage ? STAGE_LABEL[stage] : "—", detail: null, title: "No se pudo terminar", active: false };
  if (ep.status === "authorized" || ep.status === "draft") return { state: "espera", pct: 0, stage: null, stageLabel: "En espera", detail: null, title: "Esperando a que un procesador tome tu episodio", active: true };
  const last = Date.parse(raw.updatedAt ?? ep.updated_at ?? "");
  const stale = Number.isFinite(last) && now - last > STALE_MS;
  if (stale) return { state: "sin_informacion", pct, stage: stage ?? null, stageLabel: stage ? STAGE_LABEL[stage] : "Procesando", detail, title: "Sin noticias del procesador desde hace un rato", active: false };
  return { state: "procesando", pct, stage: stage ?? "preparacion", stageLabel: STAGE_LABEL[stage ?? "preparacion"], detail, title: "Produciendo tu episodio", active: true };
}

/** Mensajes discretos por etapa (no prometen tiempos). */
export function stageMessage(stage: Stage | null): string | null {
  if (stage === "voces") return "Estamos dando voz a tu episodio";
  if (stage === "imagenes") return "Preparando las imágenes de tu historia";
  if (stage === "avatares" || stage === "montaje") return "Puedes disfrutar un café mientras seguimos trabajando";
  return null;
}
