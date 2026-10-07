/**
 * Cinematic Director V1 (solo planes v4): decide CÓMO se presenta cada escena
 * por razones narrativas y después MIDE el resultado. Puro y determinista,
 * sin proveedores, sin gasto.
 *
 * Orden de prioridades (manda en cualquier conflicto):
 *   identidad > verdad narrativa > calidad cinematográfica > QA de movimiento
 *   > densidad de movimiento > variedad > costo > velocidad.
 *
 * - Zonas: HERO 0–120 s, PREMIUM 120–180 s, STANDARD 180 s+. Una escena hereda
 *   la zona MÁS exigente que toca; las métricas cuentan por intersección.
 * - Clase de movimiento desde el tratamiento EJECUTABLE (lo que de verdad
 *   dibuja remotion/LongFormDoc.tsx), nunca desde un flag "motion": video →
 *   TRUE_MOTION; imagen con cámara → PRESENTATION_MOTION; resto → STATIC.
 * - Las metas de densidad (HERO 80 %, PREMIUM 65 %) son diagnóstico: nada aquí
 *   cambia un recurso para alcanzarlas. Si la verdad impide alcanzarlas, el
 *   resultado es BLOCKED_CINEMATIC_QUALITY, nunca un recurso falso.
 * - Época: decide qué tratamientos son apropiados (no un filtro cosmético).
 */
import type { SceneDirection, SceneLook } from "../../../../remotion/long-form-direction";
import type { AssetProvenanceKind } from "./durable-shot-assets";
import type { ShotType } from "./types";
import { requiresIdentity, type BeatVisual, type VisualBeatClass } from "./visual-intents";

// --------------------------------------------------------------------------
// Zonas
// --------------------------------------------------------------------------

export const CINEMATIC_TIERS = ["HERO", "PREMIUM", "STANDARD"] as const;
export type CinematicTier = (typeof CINEMATIC_TIERS)[number];
export const HERO_END_SEC = 120;
export const PREMIUM_END_SEC = 180;
const WINDOWS: Record<CinematicTier, [number, number]> = { HERO: [0, HERO_END_SEC], PREMIUM: [HERO_END_SEC, PREMIUM_END_SEC], STANDARD: [PREMIUM_END_SEC, Infinity] };

/** Metas de DIAGNÓSTICO (no instrucciones de asignación). STANDARD no tiene mínimo. */
export const MOTION_DENSITY_TARGET: Record<CinematicTier, number | null> = { HERO: 0.8, PREMIUM: 0.65, STANDARD: null };
/** Tope de reconstrucción (por segundos) dentro de HERO. */
export const HERO_RECONSTRUCTION_CAP = 0.3;
/** Un retrato VERIFICADO puede sostenerse quieto hasta este límite sin constituir por sí solo un STATIC_RUN. */
export const VERIFIED_PORTRAIT_STATIC_MAX_SEC = 8;
export const STATIC_RUN_MAX_SEC = 10;
/** Ritmo orientativo por zona (solo informe; nunca se corta una escena para cumplirlo). */
export const RHYTHM_GUIDANCE_SEC: Record<CinematicTier, [number, number] | null> = { HERO: [3, 7], PREMIUM: [4, 8], STANDARD: null };

function overlap(start: number, end: number, [a, b]: [number, number]): number {
  return Math.max(0, Math.min(end, b) - Math.max(start, a));
}

/** Segundos de la escena dentro de cada zona (intersección temporal real). */
export function tierSeconds(startSec: number, endSec: number): Record<CinematicTier, number> {
  return { HERO: overlap(startSec, endSec, WINDOWS.HERO), PREMIUM: overlap(startSec, endSec, WINDOWS.PREMIUM), STANDARD: overlap(startSec, endSec, WINDOWS.STANDARD) };
}

/** Zona de la escena: la más exigente de cualquier segundo que toque (la escena no se parte ni se duplica). */
export function shotTier(startSec: number, endSec: number): CinematicTier {
  const s = tierSeconds(startSec, endSec);
  return s.HERO > 0 ? "HERO" : s.PREMIUM > 0 ? "PREMIUM" : "STANDARD";
}

// --------------------------------------------------------------------------
// Movimiento y costo
// --------------------------------------------------------------------------

export type MotionClass = "TRUE_MOTION" | "PRESENTATION_MOTION" | "STATIC";

/** Clase de movimiento del tratamiento que se renderiza de verdad. */
export function motionClassOf(scene: { kind: "video" | "image" | "graphic"; camera?: SceneDirection["camera"] }): MotionClass {
  if (scene.kind === "video") return "TRUE_MOTION";
  if (scene.kind === "image" && scene.camera !== undefined && scene.camera !== "still") return "PRESENTATION_MOTION";
  return "STATIC";
}

export type CostClass = "ZERO_COST" | "LOW_COST" | "GENERATIVE_COST";

/** Clase de costo de la ESTRATEGIA (no del gasto de esta ejecución): una reconstrucción es generativa aunque una prueba la simule gratis. */
export function costClassOf(executedType: ShotType, provenance?: AssetProvenanceKind | "text_card"): CostClass {
  if (executedType === "generated_placeholder" || executedType === "ai_video" || provenance === "ai_recreation") return "GENERATIVE_COST";
  // Archivo verificado: puede requerir licencia; no se inventa un precio.
  if (provenance === "archival_documentary") return "LOW_COST";
  return "ZERO_COST";
}

// --------------------------------------------------------------------------
// Época
// --------------------------------------------------------------------------

export type EraPeriod = "ancient" | "pre_photographic" | "early_photographic" | "late_20th" | "contemporary" | "unspecified";

export type EraProfile = {
  period: EraPeriod;
  /** Existe archivo FILMADO auténtico de la época. */
  filmedArchive: boolean;
  /** Se permite movimiento generado fotorrealista (video IA) — nunca donde fabricaría metraje de época. */
  generatedMotion: boolean;
  /** La acción física (tropas, multitudes, trabajo) se representa de forma esquemática, nunca fotorrealista. */
  schematicAction: boolean;
  /** Tratamiento de color: solo se aplica a archivo verificado; nunca disfraza material moderno de época. */
  grade: "archival_monochrome" | "period_color" | "neutral";
  /** Cadencia de cámara sobre imágenes fijas. */
  cadence: "archival" | "contemporary";
};

const PROFILES: Record<EraPeriod, Omit<EraProfile, "period">> = {
  // Sin fotografía ni filmación: mapas, terreno, ruinas, artefactos, reconstrucción del entorno; acción en esquema.
  ancient: { filmedArchive: false, generatedMotion: false, schematicAction: true, grade: "neutral", cadence: "archival" },
  pre_photographic: { filmedArchive: false, generatedMotion: false, schematicAction: true, grade: "neutral", cadence: "archival" },
  // Fotografía/noticiero auténticos en B/N; generar metraje "de época" sería falso archivo.
  early_photographic: { filmedArchive: true, generatedMotion: false, schematicAction: false, grade: "archival_monochrome", cadence: "archival" },
  // Color de época, video/broadcast, arquitectura, autos, señalética; movimiento real o de entorno.
  late_20th: { filmedArchive: true, generatedMotion: true, schematicAction: false, grade: "period_color", cadence: "contemporary" },
  contemporary: { filmedArchive: true, generatedMotion: true, schematicAction: false, grade: "neutral", cadence: "contemporary" },
  unspecified: { filmedArchive: true, generatedMotion: true, schematicAction: false, grade: "neutral", cadence: "contemporary" },
};

/** Perfil de época a partir del campo estructurado `era` del planner (no de la narración). */
export function eraProfile(era: string | undefined): EraProfile {
  const text = (era ?? "").toLowerCase();
  let period: EraPeriod = "unspecified";
  const bc = /\b(bc|bce|a\.?\s?c\.?)\b/.test(text);
  const year = /\b(\d{3,4})s?\b/.exec(text);
  if (bc || /\b(ancient|antiquity|antigüedad|antiguo|antigua|classical|bronze age|iron age|neolithic)\b/.test(text)) period = "ancient";
  else if (year) {
    const y = Number(year[1]);
    period = y < 500 ? "ancient" : y < 1839 ? "pre_photographic" : y < 1950 ? "early_photographic" : y < 2000 ? "late_20th" : "contemporary";
  } else if (/\b(19th|18th|17th) century\b/.test(text)) period = /19th/.test(text) ? "early_photographic" : "pre_photographic";
  else if (/\b(modern|today|present|contemporary|actual)\b/.test(text)) period = "contemporary";
  return { period, ...PROFILES[period] };
}

// --------------------------------------------------------------------------
// Tratamientos permitidos (consultado por el asignador: nunca se reserva lo prohibido)
// --------------------------------------------------------------------------

export type GenerativeVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * ¿Puede esta escena usar una estrategia generativa? Restringe, nunca amplía:
 * - identidad requerida → nunca una figura generada (B2B);
 * - acción física en épocas sin registro → esquema, nunca fotorrealismo;
 * - video IA donde fabricaría metraje de época → no.
 */
export function generativeVerdict(visual: BeatVisual | undefined, type: "image" | "video"): GenerativeVerdict {
  if (!visual) return { allowed: true };
  if (requiresIdentity(visual)) return { allowed: false, reason: "la escena exige una persona real: una recreación IA no puede representarla" };
  const era = eraProfile(visual.era);
  if (era.schematicAction && visual.motion) return { allowed: false, reason: `acción física en época ${era.period}: representación esquemática, nunca fotorrealista` };
  if (type === "video" && !era.generatedMotion) return { allowed: false, reason: `época ${era.period}: un video IA fabricaría metraje de época` };
  return { allowed: true };
}

/** La acción física de una época sin registro no admite ninguna representación fotorrealista (ni archivo moderno de recreación). */
export function requiresSchematic(visual: BeatVisual | undefined): boolean {
  return !!visual && !requiresIdentity(visual) && visual.motion && eraProfile(visual.era).schematicAction;
}

// --------------------------------------------------------------------------
// Dirección por escena
// --------------------------------------------------------------------------

export type DirectorInput = {
  startSec: number;
  endSec: number;
  durationSec: number;
  executedType: ShotType;
  kind: "video" | "image" | "graphic";
  provenance?: AssetProvenanceKind;
  visual?: BeatVisual;
  /** Vínculo de identidad confirmado por el verificador del servidor. */
  entityLink?: { name: string };
  /** La escena quedó en carencia (ABSENT). */
  gap?: boolean;
};

export type CinematicDecision = {
  tier: CinematicTier;
  tierSeconds: Record<CinematicTier, number>;
  camera: NonNullable<SceneDirection["camera"]>;
  look?: SceneLook;
  motionClass: MotionClass;
  beatClass?: VisualBeatClass;
  era: EraPeriod;
  grade: EraProfile["grade"];
  provenance: AssetProvenanceKind | "text_card";
  identityRequired: boolean;
  verifiedIdentity: boolean;
  reconstruction: boolean;
  schematic: boolean;
  costClass: CostClass;
  why: string;
};

const ARCHIVAL_MOVES: NonNullable<SceneDirection["camera"]>[] = ["push", "pull"];
const CONTEMPORARY_MOVES: NonNullable<SceneDirection["camera"]>[] = ["push", "left", "pull", "right"];

/** Decisión de presentación de cada escena, por razones narrativas (no para alcanzar una métrica). */
export function directCinematic(scenes: DirectorInput[]): CinematicDecision[] {
  let still = 0;
  return scenes.map((s) => {
    const era = eraProfile(s.visual?.era);
    const identityRequired = !!s.visual && requiresIdentity(s.visual);
    const verifiedIdentity = identityRequired && !!s.entityLink && s.provenance === "archival_documentary";
    const provenance = s.kind === "graphic" ? "text_card" : (s.provenance ?? "stock_illustrative");
    let camera: NonNullable<SceneDirection["camera"]>;
    let look: SceneLook | undefined;
    let why: string;
    if (s.kind === "video") {
      camera = "still";
      why = "movimiento propio del material: la cámara no añade nada";
    } else if (s.kind === "graphic") {
      camera = "still";
      why = requiresSchematic(s.visual)
        ? "acción física sin registro de la época: requiere esquema; sin datos cartográficos verificados se muestra el pasaje"
        : s.gap
          ? "ausencia: ningún recurso verdadero; se muestra el pasaje (mejor nada que algo falso)"
          : "tarjeta: quieta para que se lea";
    } else if (verifiedIdentity) {
      // El retrato no se dramatiza: quieto mientras dure poco; si se prolonga, un acercamiento de presentación (nunca una acción del sujeto).
      camera = s.durationSec <= VERIFIED_PORTRAIT_STATIC_MAX_SEC ? "still" : "push";
      why = camera === "still" ? "retrato verificado: se sostiene quieto, sin inventar acción" : "retrato verificado prolongado: acercamiento de presentación, sin acción del sujeto";
    } else if (s.visual?.beatClass === "EVIDENCE") {
      camera = "push";
      why = "prueba/documento: acercamiento de lectura";
    } else {
      const moves = era.cadence === "archival" ? ARCHIVAL_MOVES : CONTEMPORARY_MOVES;
      camera = moves[still++ % moves.length];
      why = s.visual?.beatClass === "PLACE" ? `lugar: recorrido de presentación (${era.cadence === "archival" ? "cadencia de archivo" : "cadencia actual"})` : `imagen fija: movimiento de presentación (${era.cadence === "archival" ? "cadencia de archivo" : "cadencia actual"})`;
    }
    // El grado de época solo sobre archivo verificado: nunca disfraza material moderno como antiguo.
    if (provenance === "archival_documentary" && era.grade === "archival_monochrome" && s.kind !== "graphic") look = { contrast: 1.1 };
    return {
      tier: shotTier(s.startSec, s.endSec),
      tierSeconds: tierSeconds(s.startSec, s.endSec),
      camera,
      look,
      motionClass: motionClassOf({ kind: s.kind, camera }),
      beatClass: s.visual?.beatClass,
      era: era.period,
      grade: era.grade,
      provenance,
      identityRequired,
      verifiedIdentity,
      reconstruction: provenance === "ai_recreation",
      schematic: requiresSchematic(s.visual),
      costClass: costClassOf(s.executedType, provenance),
      why,
    };
  });
}

// --------------------------------------------------------------------------
// QA cinematográfico (nunca gasta, nunca cambia un recurso)
// --------------------------------------------------------------------------

export const CINEMATIC_REASON_CODES = [
  "LOW_MOTION_DENSITY",
  "STATIC_RUN",
  "REPETITIVE_TREATMENT",
  "LOW_VISUAL_DIVERSITY",
  "ERA_MISMATCH",
  "GENERIC_HERO_VISUAL",
  "IDENTITY_VISUAL_VIOLATION",
  "CLASSIFICATION_INTEGRITY_GAP",
  "RECONSTRUCTION_OVERUSE",
] as const;
export type CinematicReasonCode = (typeof CINEMATIC_REASON_CODES)[number];

export type CinematicFinding = { code: CinematicReasonCode; severity: "FAIL" | "BLOCK"; shots: string[]; detail: string; tier?: CinematicTier; blockedByTruth?: boolean };

export type CinematicQaScene = CinematicDecision & {
  shotId: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  executedType: ShotType;
  display: "video" | "image" | "card";
  relevance: string;
  classificationGap?: boolean;
  gap?: boolean;
};

export type CinematicWindow = {
  tier: CinematicTier;
  seconds: number;
  motionSeconds: number;
  density: number;
  target: number | null;
  reconstructionSeconds: number;
  reconstructionShare: number;
  /** Segundos quietos que la verdad impone (ausencias de identidad, retratos verificados, esquemas sin datos). */
  truthLockedStaticSeconds: number;
  outsideRhythm: string[];
};

export type CinematicQa = {
  verdict: "PASS" | "FAIL" | "BLOCK";
  /** BLOCKED_CINEMATIC_QUALITY: la meta de movimiento solo se alcanzaría sacrificando identidad o verdad. */
  status: "PASS" | "LOW_MOTION_DENSITY" | "BLOCKED_CINEMATIC_QUALITY" | "FAIL" | "BLOCK";
  windows: CinematicWindow[];
  findings: CinematicFinding[];
};

function truthLocked(s: CinematicQaScene): boolean {
  return s.motionClass === "STATIC" && (s.identityRequired || s.schematic || !!s.classificationGap);
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function cinematicQa(scenes: CinematicQaScene[]): CinematicQa {
  const findings: CinematicFinding[] = [];
  const end = scenes.reduce((m, s) => Math.max(m, s.endSec), 0);
  const windows: CinematicWindow[] = CINEMATIC_TIERS.map((tier) => {
    const seconds = overlap(0, end, WINDOWS[tier]);
    let motionSeconds = 0;
    let reconstructionSeconds = 0;
    let truthLockedStaticSeconds = 0;
    const outsideRhythm: string[] = [];
    const rhythm = RHYTHM_GUIDANCE_SEC[tier];
    for (const s of scenes) {
      const inside = s.tierSeconds[tier];
      if (inside <= 0) continue;
      if (s.motionClass !== "STATIC") motionSeconds += inside;
      if (s.reconstruction) reconstructionSeconds += inside;
      if (truthLocked(s)) truthLockedStaticSeconds += inside;
      if (rhythm && s.tier === tier && (s.durationSec < rhythm[0] || s.durationSec > rhythm[1])) outsideRhythm.push(s.shotId);
    }
    return {
      tier,
      seconds: round3(seconds),
      motionSeconds: round3(motionSeconds),
      density: seconds > 0 ? round3(motionSeconds / seconds) : 0,
      target: MOTION_DENSITY_TARGET[tier],
      reconstructionSeconds: round3(reconstructionSeconds),
      reconstructionShare: seconds > 0 ? round3(reconstructionSeconds / seconds) : 0,
      truthLockedStaticSeconds: round3(truthLockedStaticSeconds),
      outsideRhythm,
    };
  });

  for (const w of windows) {
    if (w.target === null || w.seconds <= 0 || w.density + 1e-9 >= w.target) continue;
    // Si ni contando como movimiento lo que la verdad deja quieto se llega a la meta, la culpa NO es de la verdad.
    const truth = (w.motionSeconds + w.truthLockedStaticSeconds) / w.seconds + 1e-9 >= w.target;
    findings.push({
      code: "LOW_MOTION_DENSITY",
      severity: "FAIL",
      tier: w.tier,
      blockedByTruth: truth,
      shots: scenes.filter((s) => s.tierSeconds[w.tier] > 0 && s.motionClass === "STATIC").map((s) => s.shotId),
      detail: `${w.tier}: ${Math.round(w.density * 100)} % de movimiento (meta diagnóstica ${Math.round(w.target * 100)} %)${truth ? " — solo alcanzable sacrificando identidad/verdad" : ""}`,
    });
  }
  const hero = windows[0];
  if (hero.seconds > 0 && hero.reconstructionShare > HERO_RECONSTRUCTION_CAP + 1e-9) {
    findings.push({
      code: "RECONSTRUCTION_OVERUSE",
      severity: "FAIL",
      tier: "HERO",
      shots: scenes.filter((s) => s.reconstruction && s.tierSeconds.HERO > 0).map((s) => s.shotId),
      detail: `reconstrucción ${Math.round(hero.reconstructionShare * 100)} % de HERO (tope ${HERO_RECONSTRUCTION_CAP * 100} %)`,
    });
  }

  // Corridas quietas: 2 consecutivas o ≥ 10 s. Un retrato VERIFICADO de ≤ 8 s no forma corrida por sí solo
  // (se salta), pero sus segundos siguen contando como STATIC en la densidad.
  let run: CinematicQaScene[] = [];
  const flush = () => {
    const secs = run.reduce((a, s) => a + s.durationSec, 0);
    if (run.length >= 2 || secs >= STATIC_RUN_MAX_SEC) {
      const truth = run.every(truthLocked);
      findings.push({ code: "STATIC_RUN", severity: "FAIL", blockedByTruth: truth, shots: run.map((s) => s.shotId), detail: `${run.length} escena(s) quietas seguidas, ${round3(secs)} s${truth ? " — impuestas por la verdad (identidad/esquema)" : ""}` });
    }
    run = [];
  };
  for (const s of scenes) {
    if (s.motionClass !== "STATIC") {
      flush();
      continue;
    }
    if (s.verifiedIdentity && s.durationSec <= VERIFIED_PORTRAIT_STATIC_MAX_SEC) continue;
    run.push(s);
  }
  flush();

  // Monotonía real: 3+ escenas seguidas con el mismo tratamiento (clase, cámara, procedencia).
  for (let i = 0; i + 2 < scenes.length; i++) {
    const key = (s: CinematicQaScene) => `${s.motionClass}|${s.camera}|${s.provenance}`;
    if (key(scenes[i]) === key(scenes[i + 1]) && key(scenes[i]) === key(scenes[i + 2])) {
      let j = i + 2;
      while (j + 1 < scenes.length && key(scenes[j + 1]) === key(scenes[i])) j++;
      findings.push({ code: "REPETITIVE_TREATMENT", severity: "FAIL", shots: scenes.slice(i, j + 1).map((s) => s.shotId), detail: `mismo tratamiento ${key(scenes[i])}` });
      i = j;
    }
  }
  // Variedad: en HERO/PREMIUM, un mismo papel visual (procedencia × movimiento) no domina > 75 % del tiempo.
  for (const tier of ["HERO", "PREMIUM"] as const) {
    const inTier = scenes.filter((s) => s.tierSeconds[tier] > 0);
    const total = inTier.reduce((a, s) => a + s.tierSeconds[tier], 0);
    if (inTier.length < 4 || total <= 0) continue;
    const byRole = new Map<string, number>();
    for (const s of inTier) byRole.set(`${s.provenance}|${s.motionClass}`, (byRole.get(`${s.provenance}|${s.motionClass}`) ?? 0) + s.tierSeconds[tier]);
    const [role, secs] = [...byRole.entries()].sort((a, b) => b[1] - a[1])[0];
    if (secs / total > 0.75) findings.push({ code: "LOW_VISUAL_DIVERSITY", severity: "FAIL", tier, shots: inTier.map((s) => s.shotId), detail: `${tier}: ${role} ocupa ${Math.round((secs / total) * 100)} %` });
  }

  for (const s of scenes) {
    // Identidad: solo archivo con vínculo verificado (o la ausencia) puede ocupar una escena que exige a una persona real.
    if (s.identityRequired && s.display !== "card" && !s.verifiedIdentity) {
      findings.push({ code: "IDENTITY_VISUAL_VIOLATION", severity: "BLOCK", shots: [s.shotId], detail: `escena de identidad con ${s.provenance} sin vínculo verificado` });
    }
    if (s.display === "video" && s.provenance === "archival_documentary" && (s.era === "ancient" || s.era === "pre_photographic")) {
      findings.push({ code: "ERA_MISMATCH", severity: "BLOCK", shots: [s.shotId], detail: `no existe archivo filmado de la época ${s.era}` });
    }
    if (s.executedType === "ai_video" && (s.era === "ancient" || s.era === "pre_photographic" || s.era === "early_photographic")) {
      findings.push({ code: "ERA_MISMATCH", severity: "BLOCK", shots: [s.shotId], detail: `video IA en época ${s.era}: fabricaría metraje de época` });
    }
    if (s.schematic && s.display !== "card") {
      findings.push({ code: "ERA_MISMATCH", severity: "BLOCK", shots: [s.shotId], detail: `acción física en época ${s.era} presentada de forma fotorrealista` });
    }
    if (s.tier === "HERO" && s.display !== "card" && (s.relevance === "unverified" || s.relevance === "unknown")) {
      findings.push({ code: "GENERIC_HERO_VISUAL", severity: "FAIL", tier: "HERO", shots: [s.shotId], detail: "recurso en HERO sin pertinencia comprobada" });
    }
    if (s.classificationGap) {
      findings.push({ code: "CLASSIFICATION_INTEGRITY_GAP", severity: "FAIL", shots: [s.shotId], detail: "clasificación incierta o contradictoria: la escena falló cerrada (sin material genérico)" });
    }
  }

  const verdict = findings.some((f) => f.severity === "BLOCK") ? "BLOCK" : findings.length > 0 ? "FAIL" : "PASS";
  // BLOCKED_CINEMATIC_QUALITY: todo lo que falla lo impone la verdad (y la clasificación que falló cerrada).
  const truthOnly = findings.some((f) => f.blockedByTruth) && findings.every((f) => f.blockedByTruth || f.code === "CLASSIFICATION_INTEGRITY_GAP");
  const onlyDensity = findings.every((f) => f.code === "LOW_MOTION_DENSITY");
  const status: CinematicQa["status"] =
    verdict === "BLOCK" ? "BLOCK" : verdict === "PASS" ? "PASS" : truthOnly ? "BLOCKED_CINEMATIC_QUALITY" : onlyDensity ? "LOW_MOTION_DENSITY" : "FAIL";
  return { verdict, status, windows, findings };
}
