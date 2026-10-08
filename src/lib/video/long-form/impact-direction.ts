/**
 * Plan v6 — Cinematic Opening (OFFLINE). IMPACT DENTRO DE LA SECUENCIA.
 *
 * v5 respondió qué comunica cada secuencia y qué roles necesita. v6 decide
 * DÓNDE cae el peso (3 golpe/gancho/revelación, 2 desarrollo, 1 prueba/respiro)
 * y cómo se PRESENTA un recurso que ya pasó la verdad:
 *
 *   escenas v5 (directSequenceScenes, ya verificadas) → directImpactScenes → LongFormDoc
 *
 * El impacto NUNCA elige ni aprueba un recurso, nunca cambia la velocidad del
 * zoom, el color, el número de planos ni la dirección de la cámara (que sigue
 * decidida por el rol). Solo decide el encuadre (a sangre o en campo), la
 * jerarquía tipográfica (año/nombre) y la revelación del documento curado.
 */
import type { LongFormShotScene } from "../../../../remotion/LongFormDoc";
import type { Shot } from "./types";
import type { ShotExecution } from "./shot-executor";
import type { ExecutableSequence } from "./sequence-intent";

/** Ventana del gancho de apertura. */
export const HOOK_WINDOW_SEC = 15;

export type HookStatus = { status: "HOOK_FILLED" | "HOOK_UNFILLED" | "NO_HOOK_DECLARED"; shotId?: string; reason: string };

/**
 * Dirección v6 sobre escenas v5. Solo cambia la PRESENTACIÓN de lo que ya se ejecutó.
 * Impacto 3: lugar a sangre con su año como declaración de apertura; presentación del
 * protagonista con su nombre VERIFICADO; revelación continua del titular curado.
 * Impacto 1: contención (sin rótulos de énfasis). Impacto 2: el tratamiento v5.
 */
export function directImpactScenes(scenes: LongFormShotScene[], shots: Pick<Shot, "sequenceSlot">[], executions: Pick<ShotExecution, "assetMeta">[]): LongFormShotScene[] {
  return scenes.map((scene, i) => {
    const slot = shots[i]?.sequenceSlot;
    const shot = scene.direction?.shot;
    if (!slot?.impact || !shot) return scene;
    let next = { ...shot, impact: slot.impact };
    const media = scene.asset.kind === "media";
    if (slot.impact === 3) {
      if (media && shot.scale === "WIDE") {
        // Declaración de apertura: el lugar llena el cuadro; el año deja de ser un rótulo pequeño.
        next = { ...next, wide: "bleed" };
        if (shot.slug) {
          next = { ...next, statement: { ...shot.slug } };
          delete next.slug;
        }
      }
      // El nombre SOLO del vínculo de identidad verificado por el servidor (nunca del texto del planner).
      const verifiedName = executions[i]?.assetMeta?.selection?.entityLink?.name;
      if (media && shot.scale === "MEDIUM" && slot.role === "ANCHOR" && verifiedName && executions[i]?.assetMeta?.provenance?.kind === "archival_documentary") next = { ...next, name: verifiedName };
      // Revelación: movimiento continuo de la página completa al titular curado (solo si existe la región).
      if (shot.scale === "DETAIL" && shot.region) next = { ...next, reveal: true };
    } else if (slot.impact === 1 && next.slug) {
      // Respiro: contención, sin énfasis tipográfico.
      delete next.slug;
    }
    return { ...scene, direction: { ...scene.direction!, shot: next } };
  });
}

/**
 * Gancho (primeros 15 s): el planner declara un momento de impacto 3 ahí; si lo que se ejecutó
 * es una ausencia (tarjeta), el gancho queda SIN LLENAR — nunca con metraje genérico.
 */
export function hookStatus(scenes: LongFormShotScene[]): HookStatus {
  const scene = scenes.find((s) => s.direction?.shot?.impact === 3 && s.startSeconds < HOOK_WINDOW_SEC);
  if (!scene) return { status: "NO_HOOK_DECLARED", reason: "ningún momento de impacto 3 en los primeros 15 s" };
  const filled = scene.asset.kind === "media" || (scene.asset.kind === "graphic" && scene.asset.graphic.kind === "curated_svg");
  return filled
    ? { status: "HOOK_FILLED", shotId: scene.id, reason: `${scene.direction?.shot?.role} verdadero` }
    : { status: "HOOK_UNFILLED", shotId: scene.id, reason: "el gancho declarado no tiene ancla, prueba ni contexto legal: ausencia dirigida" };
}

/** Lo mismo ANTES de gastar, desde la secuencia resuelta (un ancla/prueba en ausencia ya no puede llenar el gancho). */
export function plannedHookStatus(sequences: ExecutableSequence[], shots: Pick<Shot, "sequenceSlot" | "startSec" | "id">[]): HookStatus {
  const shot = shots.find((s) => s.sequenceSlot?.impact === 3 && s.startSec < HOOK_WINDOW_SEC);
  if (!shot?.sequenceSlot) return { status: "NO_HOOK_DECLARED", reason: "ningún momento de impacto 3 en los primeros 15 s" };
  const slot = sequences.find((s) => s.id === shot.sequenceSlot!.sequenceId)?.slots[shot.sequenceSlot.index];
  return slot && (slot.status === "FILL" || slot.status === "RECOMPOSED" || slot.status === "PENDING_SELECTOR")
    ? { status: "HOOK_FILLED", shotId: shot.id, reason: `${slot.role}: ${slot.status}` }
    : { status: "HOOK_UNFILLED", shotId: shot.id, reason: slot?.reason ?? "sin material verdadero para el gancho" };
}

// --------------------------------------------------------------------------
// Política generativa FUTURA — SOLO DISEÑO (esta misión: cero llamadas)
// --------------------------------------------------------------------------

/** Usos que una futura atmósfera generada NUNCA puede cubrir. */
export const FUTURE_GENERATIVE_FORBIDDEN: { code: string; pattern: RegExp }[] = [
  { code: "IDENTIFIED_PERSON", pattern: /\b(he|she|him|her|portrait|face|person|man|woman|people|crowd|businessman|bellboy|attendant|worker)\b/i },
  { code: "CRIME_REENACTMENT", pattern: /\b(murder|killing|shot|shooting|gun|weapon|knife|body|victim|perpetrator|assault|blood|crime scene)\b/i },
  { code: "COURT_EVENT", pattern: /\b(court|trial|verdict|judge|courtroom|testimony|interview)\b/i },
  { code: "DOCUMENT_OR_HEADLINE", pattern: /\b(document|newspaper|headline|letter|contract|register|ruling|evidence)\b/i },
  { code: "HISTORICAL_EVENT_AS_FOOTAGE", pattern: /\b(archival|archive footage|newsreel|historical footage|reenactment)\b/i },
];

export type FutureAtmosphereRequest = { shotId: string; role: string; description: string; verdict: "ADVISORY_ALLOWED" | "FORBIDDEN"; reasons: string[]; provenanceRequired: "ai_recreation" };

/**
 * Peticiones ASESORAS de ambiente futuro (ciudad vacía, clima, arquitectura, paisaje, interiores vacíos,
 * objetos). Nunca se ejecutan: el presupuesto, el suministro y la puerta de llamadas pagadas existentes
 * siguen mandando. Una petición que pudiera probar identidad, hecho, prueba o acción histórica se rechaza.
 */
export function futureAtmosphereRequests(shots: Pick<Shot, "id" | "sequenceSlot" | "anchoredVisual">[], declared: Map<string, string>): FutureAtmosphereRequest[] {
  const out: FutureAtmosphereRequest[] = [];
  shots.forEach((s) => {
    const description = declared.get(`${s.sequenceSlot?.sequenceId}#${s.sequenceSlot?.index}`);
    if (!description || !s.sequenceSlot) return;
    const reasons = FUTURE_GENERATIVE_FORBIDDEN.filter((f) => f.pattern.test(description)).map((f) => f.code);
    if (s.sequenceSlot.role !== "CONTEXT" && s.sequenceSlot.role !== "ATMOSPHERE") reasons.push("ROLE_NOT_ATMOSPHERIC");
    if (s.anchoredVisual?.identity || s.anchoredVisual?.evidence) reasons.push("PROTECTED_CONTRACT");
    out.push({ shotId: s.id, role: s.sequenceSlot.role, description, verdict: reasons.length ? "FORBIDDEN" : "ADVISORY_ALLOWED", reasons, provenanceRequired: "ai_recreation" });
  });
  return out;
}
