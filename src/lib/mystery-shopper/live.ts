/**
 * Mystery Shopper 2.0 — evaluación a partir de lo que un navegador NUEVO observó en ATOMIVID.
 *
 * Reglas:
 *  - Una nota de producto solo existe si la misión se cumplió de forma verificable; si no, «NO EVALUADO».
 *  - Un bloqueo crítico anula la nota (no se promedia con lo bueno).
 *  - Cada hallazgo separa HECHO (medido), INTERPRETACIÓN y RECOMENDACIÓN; sin medición no hay hallazgo.
 *  - Un archivo reproducible que no dura lo pedido es FAIL funcional.
 */
import type { ProductId, ProfileId } from "./types";

export const LIVE_VERSION = "mystery-shopper-2.0";

export type StepState = "PASS" | "FAIL" | "SKIP" | "BLOCKED";
export type LiveStep = {
  n: number;
  name: string;
  state: StepState;
  detail: string;
  screenshot: string | null;
  ms: number;
  url: string | null;
};
export type ActionLog = { t: string; action: string; detail: string };

export type PageMetrics = {
  url: string;
  viewport: { width: number; height: number };
  horizontalOverflowPx: number;
  smallTargets: number;
  unlabeledFields: number;
  technicalTerms: string[];
  costVisible: boolean;
  errorsVisible: string[];
  consoleErrors: number;
  loadMs: number;
  httpStatus: number | null;
};

export type MediaCheck = {
  file: string;
  playable: boolean;
  container: string | null;
  durationSeconds: number | null;
  requestedSeconds: number | null;
  /** Archivo técnicamente reproducible; independiente de si cumple lo pedido. */
  technical: "PASS" | "FAIL" | "NO_MEDIDO";
  /** ¿Dura lo pedido? Un MP3 válido de 2 s para 10 min es FAIL. */
  durationConformity: "PASS" | "FAIL" | "NO_MEDIDO";
  topic: "NO_MEDIDO";
  voices: "NO_MEDIDO";
  language: "NO_MEDIDO";
  lipSync: "NO_MEDIDO";
  musicLevels: "PASS" | "FAIL" | "NO_MEDIDO";
  recoverableInLibrary: "PASS" | "FAIL" | "NO_MEDIDO";
  notes: string[];
};

export type Finding = {
  severity: "P0" | "P1" | "P2" | "P3";
  product: ProductId;
  screen: string;
  fact: string;
  interpretation: string;
  recommendation: string;
  evidence: string | null;
};

export type ProductVerdict = {
  product: ProductId;
  /** EVALUADO solo si cada criterio de éxito de la misión se comprobó. */
  coverage: "EVALUADO" | "PARCIAL" | "NO_EVALUADO";
  verdict: "FUNCIONA" | "CON_PROBLEMAS" | "BLOQUEADO" | "NO_EVALUADO";
  score: number | null;
  criteria: { text: string; met: boolean | null; evidence: string }[];
  criticalBlock: string | null;
};

export type LiveReport = {
  version: typeof LIVE_VERSION;
  jobId: string;
  scope: "atomivid-real";
  target: { kind: string; url: string };
  observedSha: string | null;
  missionId: string;
  product: ProductId;
  profile: ProfileId;
  mode: "gratuito" | "real";
  authenticated: boolean;
  browser: { sessionId: string; version: string; freshContext: boolean; viewport: { width: number; height: number } };
  startedAt: string;
  finishedAt: string;
  spendUsd: number;
  steps: LiveStep[];
  pages: PageMetrics[];
  media: MediaCheck[];
  findings: Finding[];
  verdict: ProductVerdict;
  plain: { doing: string; found: string; worked: string[]; failed: string[]; simplify: string[]; needsAuthorization: string[] };
  humanGate: string | null;
  actionsLog: string;
};

/** Tolerancia de duración: ±15 % o ±5 s (lo mayor). */
export function durationConformity(requested: number | null, actual: number | null): "PASS" | "FAIL" | "NO_MEDIDO" {
  if (!requested || !actual || !Number.isFinite(requested) || !Number.isFinite(actual)) return "NO_MEDIDO";
  const tol = Math.max(5, requested * 0.15);
  return Math.abs(actual - requested) <= tol ? "PASS" : "FAIL";
}

export function mediaCheck(input: { file: string; container: string | null; durationSeconds: number | null; decodeOk: boolean; requestedSeconds: number | null; meanVolumeDb: number | null; inLibrary: boolean | null }): MediaCheck {
  const technical = input.container && input.decodeOk && (input.durationSeconds ?? 0) > 0 ? "PASS" : input.container ? "FAIL" : "NO_MEDIDO";
  const dc = durationConformity(input.requestedSeconds, input.durationSeconds);
  const notes: string[] = [];
  if (technical === "PASS" && dc === "FAIL") notes.push(`Se reproduce, pero dura ${input.durationSeconds?.toFixed(1)} s frente a ${input.requestedSeconds} s pedidos: no cumple la misión.`);
  const music = input.meanVolumeDb === null ? "NO_MEDIDO" : input.meanVolumeDb > -40 && input.meanVolumeDb < -8 ? "PASS" : "FAIL";
  return {
    file: input.file, playable: technical === "PASS", container: input.container, durationSeconds: input.durationSeconds, requestedSeconds: input.requestedSeconds,
    technical, durationConformity: dc, topic: "NO_MEDIDO", voices: "NO_MEDIDO", language: "NO_MEDIDO", lipSync: "NO_MEDIDO", musicLevels: music,
    recoverableInLibrary: input.inLibrary === null ? "NO_MEDIDO" : input.inLibrary ? "PASS" : "FAIL",
    notes: [...notes, "Tema, voces, idioma y sincronía labial: NO MEDIDOS (no hay método automático fiable; no se aprueban por apariencia)."],
  };
}

const TECH = ["MP3", "MP4", "códec", "codec", "bitrate", "LUFS", "dBTP", "fps", "H.264", "AAC", "JSON", "UUID", "idempotencia", "worker"];
export function technicalTerms(text: string): string[] {
  return TECH.filter((t) => new RegExp(`(^|[^A-Za-z])${t.replace(".", "\\.")}([^A-Za-z]|$)`).test(text));
}

/** Hallazgos SOLO a partir de mediciones. Sin dato, no se critica. */
export function findingsFrom(product: ProductId, profile: ProfileId, pages: PageMetrics[], steps: LiveStep[], media: MediaCheck[]): Finding[] {
  const out: Finding[] = [];
  for (const p of pages) {
    const screen = new URL(p.url).pathname;
    if (p.httpStatus && p.httpStatus >= 500) out.push({ severity: "P0", product, screen, fact: `La página respondió HTTP ${p.httpStatus}.`, interpretation: "El cliente no puede usar esta pantalla.", recommendation: "Corregir el error del servidor antes de cualquier mejora visual.", evidence: null });
    if (p.horizontalOverflowPx > 1) out.push({ severity: p.viewport.width <= 420 ? "P1" : "P2", product, screen, fact: `A ${p.viewport.width}px el contenido se sale ${p.horizontalOverflowPx}px a la derecha.`, interpretation: "En el celular hay que desplazar de lado para ver todo; parte de los controles queda oculta.", recommendation: "Ajustar el ancho de los elementos que desbordan (tablas, menús o textos largos) al ancho de la pantalla.", evidence: null });
    if (p.unlabeledFields > 0) out.push({ severity: "P2", product, screen, fact: `${p.unlabeledFields} campo(s) sin etiqueta visible ni accesible.`, interpretation: "Un principiante no sabe qué escribir y un lector de pantalla no lo anuncia.", recommendation: "Poner una etiqueta corta a cada campo.", evidence: null });
    if (p.smallTargets > 6 && p.viewport.width <= 420) out.push({ severity: "P3", product, screen, fact: `${p.smallTargets} controles miden menos de 44 px de alto en ${p.viewport.width}px.`, interpretation: "Con el dedo es fácil pulsar el control equivocado.", recommendation: "Subir a 44 px los botones y enlaces principales.", evidence: null });
    if (p.technicalTerms.length && (profile === "principiante" || profile === "impaciente")) out.push({ severity: "P3", product, screen, fact: `Se ven términos técnicos: ${p.technicalTerms.join(", ")}.`, interpretation: "Para quien no es técnico, son palabras que no ayudan a decidir.", recommendation: "Cambiarlos por palabras de uso diario (p. ej. «Descargar audio» en vez de «Descargar MP3»), dejando el detalle técnico en una sección secundaria.", evidence: null });
    if (p.errorsVisible.length) out.push({ severity: "P1", product, screen, fact: `Mensaje de error visible: «${p.errorsVisible[0].slice(0, 140)}».`, interpretation: "El cliente se encuentra un error en el recorrido normal.", recommendation: "Revisar la causa; si es esperado, decir qué hacer a continuación.", evidence: null });
    if (p.loadMs > 8000) out.push({ severity: "P2", product, screen, fact: `La pantalla tardó ${(p.loadMs / 1000).toFixed(1)} s en estar lista.`, interpretation: "Un cliente impaciente abandona antes de verla.", recommendation: "Mostrar contenido útil antes o reducir lo que se carga al entrar.", evidence: null });
  }
  for (const s of steps) {
    if (s.state === "FAIL") out.push({ severity: "P1", product, screen: s.url ? new URL(s.url).pathname : "", fact: `Paso «${s.name}» falló: ${s.detail.slice(0, 200)}`, interpretation: "El cliente no puede completar esta parte de la misión.", recommendation: "Corregir el paso o explicar en pantalla cómo continuar.", evidence: s.screenshot });
  }
  for (const m of media) {
    if (m.durationConformity === "FAIL") out.push({ severity: "P0", product, screen: "resultado", fact: m.notes[0] ?? "La duración no corresponde a lo pedido.", interpretation: "El cliente pidió un contenido y recibió otro mucho más corto o largo.", recommendation: "No marcar como terminado un archivo que no cumple la duración; avisar antes de cobrar.", evidence: m.file });
  }
  return out;
}

/** Nota 0–100 solo con misión cumplida; un bloqueo crítico o un P0 anulan la nota. */
export function verdictFor(product: ProductId, criteria: ProductVerdict["criteria"], findings: Finding[], critical: string | null): ProductVerdict {
  const checked = criteria.filter((c) => c.met !== null);
  const coverage: ProductVerdict["coverage"] = criteria.length > 0 && checked.length === criteria.length ? "EVALUADO" : checked.length > 0 ? "PARCIAL" : "NO_EVALUADO";
  const p0 = findings.find((f) => f.severity === "P0");
  const block = critical ?? (p0 ? p0.fact : null);
  if (block) return { product, coverage, verdict: "BLOQUEADO", score: null, criteria, criticalBlock: block };
  if (coverage !== "EVALUADO") return { product, coverage, verdict: "NO_EVALUADO", score: null, criteria, criticalBlock: null };
  const unmet = criteria.filter((c) => c.met === false).length;
  const penalty = findings.reduce((s, f) => s + (f.severity === "P1" ? 12 : f.severity === "P2" ? 5 : f.severity === "P3" ? 2 : 0), 0) + unmet * 20;
  const score = Math.max(0, Math.min(100, 100 - penalty));
  return { product, coverage, verdict: unmet === 0 && !findings.some((f) => f.severity === "P1") ? "FUNCIONA" : "CON_PROBLEMAS", score, criteria, criticalBlock: null };
}
