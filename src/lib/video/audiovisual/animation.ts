/**
 * «Animación IA» en Reels: plan PURO (sin red) de cada clip image-to-video.
 *
 * Modelo y modalidad (adaptador existente src/lib/providers/video-gen/veo.ts,
 * el mismo que produjo el clip real de Panamá/P2B):
 *  - Google Veo 3.1 Fast, `veo-3.1-fast-generate-preview`, Gemini API REST
 *    `predictLongRunning`.
 *  - SOLO image-to-video: la ilustración de la escena viaja como imagen de
 *    entrada real (`instances[0].image.bytesBase64Encoded`). El adaptador
 *    rechaza pedidos sin imagen; nunca cae a text-to-video.
 *  - 9:16, 1080p, 8 s por clip (única duración verificada con una llamada
 *    real a 1080p), US$0,12 por segundo → US$0,96 por clip.
 *  - Veo SIEMPRE genera audio: el render lo silencia (OffthreadVideo muted);
 *    la narración y la música de ATOMIVID son el único audio.
 *
 * Continuidad: una «biblia» compartida (estilo, paleta, lugar, sujeto
 * recurrente) entra en el prompt de TODAS las ilustraciones base y de todos
 * los clips. Compartir texto no garantiza identidad visual: la revisión
 * visual de cada muestra sigue pendiente (ver docs/AUDIOVISUAL_PROFILES.md).
 */
import { createHash } from "node:crypto";
import { VEO_DURATION_SECONDS_1080P, VEO_MODEL, VEO_TARGET_RESOLUTION, getVeoCostUsdPerSecond } from "@/lib/providers/video-gen/veo";
import type { ScriptScene } from "@/lib/providers/types";
import { WORDS_PER_SECOND } from "@/lib/video/script-pacing";
import { PROFILES, type IntentId, type ProfileId } from "./catalog";
import type { SceneEnergy } from "./direction";
import { INTENT_LIGHTING } from "./visuals";

export const REEL_ANIMATION = {
  provider: "veo",
  model: VEO_MODEL,
  resolution: VEO_TARGET_RESOLUTION,
  aspectRatio: "9:16" as const,
  clipSeconds: VEO_DURATION_SECONDS_1080P,
};

/** Segundos facturables × tarifa registrada (veo.ts). Image-to-video cuesta lo mismo que text-to-video. */
export function animationClipCostUsd(): number {
  return REEL_ANIMATION.clipSeconds * getVeoCostUsdPerSecond();
}

/**
 * Velocidad de narración CONSERVADORA para estimar la duración de una
 * escena antes de tener la voz (la real ronda 2,5 palabras/s). Si una
 * escena pudiera superar el clip, se avisa antes de gastar.
 */
const CONSERVATIVE_WORDS_PER_SECOND = 2.2;
/** Margen para el fundido con la escena siguiente (el plano se prolonga por debajo de ella). */
const TRANSITION_MARGIN_SECONDS = 0.8;

export function estimatedSceneSeconds(text: string): number {
  return text.split(/\s+/).filter(Boolean).length / CONSERVATIVE_WORDS_PER_SECOND;
}

/** Escenas cuya narración estimada no cabe en un clip (antes de la voz; la comprobación exacta ocurre con los tiempos reales). */
export function scenesTooLongForClip(texts: string[], clipSeconds = REEL_ANIMATION.clipSeconds): number[] {
  return texts.map((t, i) => (estimatedSceneSeconds(t) + TRANSITION_MARGIN_SECONDS > clipSeconds ? i : -1)).filter((i) => i >= 0);
}

export type ContinuityBible = {
  style: string;
  palette: string;
  setting: string;
  recurringSubject: string;
  constants: string[];
  /** Texto que entra tal cual en todos los prompts. */
  text: string;
};

/** Estilo de la ilustración base: el del perfil ilustrado o, en perfiles de stock, su estilo base de animación. */
export function animationBaseStyle(profile: ProfileId): { style: string; negative: string } {
  const p = PROFILES[profile];
  const style = p.imageStyle ?? p.animationBaseStyle;
  if (!style) throw new Error(`El perfil ${profile} no define un estilo para la ilustración base`);
  return { style, negative: p.imageNegative ?? p.animationBaseNegative ?? "text, watermark, logo" };
}

const clean = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Descripción compartida por todas las escenas. Se deriva de datos que ya
 * existen (perfil, intención, tema y el concepto visual de la escena 1);
 * no es una comprensión semántica del guion.
 */
export function buildContinuityBible(input: { profile: ProfileId; intent: IntentId; topic?: string; scenes: Pick<ScriptScene, "visualQuery" | "visualConcepts">[] }): ContinuityBible {
  const { style } = animationBaseStyle(input.profile);
  const palette = INTENT_LIGHTING[input.intent];
  const setting = clean(input.topic ?? "", 140) || "the story's main location";
  const first = input.scenes[0];
  const recurringSubject = clean(first?.visualConcepts?.[0] ?? first?.visualQuery ?? "the main subject", 100);
  const constants = [
    "same art style and rendering technique in every scene",
    "same color palette and lighting mood",
    `same design, colors and proportions of the recurring subject (${recurringSubject}) whenever it appears`,
    "same location architecture and props across scenes",
  ];
  const text =
    `Series continuity — style: ${style}. Palette and light: ${palette}. Setting: ${setting}. ` +
    `Recurring subject: ${recurringSubject}. Keep constant: ${constants.join("; ")}.`;
  return { style, palette, setting, recurringSubject, constants, text };
}

/**
 * Coreografía de la acción de una escena, compartida por la ilustración
 * base (primer fotograma) y el clip:
 *  - start: pose INICIAL, anterior a la acción y compatible con ella (la
 *    acción aún no empezó). Muestra real: un guardián que ya miraba la
 *    ventana no tenía giro que hacer.
 *  - action: la acción principal declarada (una sola).
 *  - end: destino y estado final, que se MANTIENE hasta el corte. Muestra
 *    real: una puerta cerraba a tiempo y después volvía a abrirse.
 *  - constraints: restricciones de la escena. Efectos, clima y elementos
 *    que la escena no menciona quedan prohibidos. Muestra real: un faro
 *    añadió llamas y destellos que nadie pidió.
 * Si el guion no trae start/end, se usa una formulación explícita genérica
 * (declaredStart/declaredEnd = false) — nunca se inventa una pose concreta.
 */
export type ActionPlan = { start: string; action: string; end: string; constraints: string[]; declaredStart: boolean; declaredEnd: boolean };

const SCENE_EFFECTS: { constraint: string; negative: string; mentions: string[] }[] = [
  { constraint: "no fire or flames", negative: "fire, flames", mentions: ["fire", "flame", "burn", "torch", "candle", "blaze", "fuego", "llama", "antorcha", "vela", "incendi", "arde", "ardi", "hoguera"] },
  { constraint: "no flashes, sparks or lightning", negative: "flashes, sparks, lightning", mentions: ["flash", "spark", "lightning", "thunder", "destello", "chispa", "relámpago", "relampago", "rayo", "trueno"] },
  { constraint: "no smoke", negative: "smoke", mentions: ["smoke", "humo", "smolder"] },
  { constraint: "no fog or mist", negative: "fog, mist", mentions: ["fog", "mist", "haze", "niebla", "bruma", "neblina"] },
  { constraint: "no rain", negative: "rain", mentions: ["rain", "storm", "downpour", "lluvia", "llov", "tormenta", "aguacero"] },
  { constraint: "no snow", negative: "snow", mentions: ["snow", "blizzard", "nieve", "nevad", "nevan"] },
  { constraint: "no wind-blown motion", negative: "strong wind", mentions: ["wind", "gust", "breeze", "viento", "ráfaga", "rafaga", "brisa", "vendaval"] },
  { constraint: "no dust or flying debris", negative: "dust clouds, flying debris", mentions: ["dust", "debris", "pebble", "stones", "gravel", "dirt", "polvo", "escombro", "piedra", "grava", "tierra"] },
  { constraint: "no explosions", negative: "explosions", mentions: ["explo", "blast", "estall"] },
];

/** Restricciones de la escena: lo que no menciona, no aparece. */
export function sceneConstraints(texts: (string | undefined)[]): { constraints: string[]; negatives: string[] } {
  const haystack = texts.filter(Boolean).join(" ").toLowerCase();
  const absent = SCENE_EFFECTS.filter((e) => !e.mentions.some((m) => haystack.includes(m)));
  return {
    constraints: [...absent.map((e) => e.constraint), "no new characters, animals, objects or light sources that the scene does not mention"],
    negatives: absent.map((e) => e.negative),
  };
}

export function planSceneAction(segment: Pick<ScriptScene, "text" | "visualQuery" | "visualConcepts" | "visibleAction" | "actionStart" | "actionEnd">): ActionPlan {
  const declared = segment.visibleAction?.trim();
  if (!declared || declared.length < 3) throw new AnimationPlanError("La escena no declara una acción visible concreta; no se anima sin ella.");
  const action = clean(declared, 160);
  const start = segment.actionStart?.trim();
  const end = segment.actionEnd?.trim();
  const { constraints } = sceneConstraints([segment.text, segment.visualQuery, ...(segment.visualConcepts ?? []), action, start, end]);
  return {
    action,
    start: start ? clean(start, 160) : `the moment just before "${action}": that action has not started yet`,
    end: end ? clean(end, 160) : `the result of "${action}" is reached and stays still`,
    constraints,
    declaredStart: Boolean(start),
    declaredEnd: Boolean(end),
  };
}

/** Prompt de la ilustración base de una escena en modo animación (estilo + continuidad + contenido + pose inicial). */
export function buildAnimationBaseImagePrompt(input: {
  profile: ProfileId;
  bible: ContinuityBible;
  concept: string;
  narration: string;
  /** Coreografía de la escena: el primer fotograma muestra la pose ANTERIOR a la acción. */
  action?: ActionPlan;
}): { prompt: string; negativePrompt: string; key: string } {
  const { negative } = animationBaseStyle(input.profile);
  const act = input.action;
  const firstFrame = act
    ? `This image is the FIRST frame of a short animated shot. Show exactly this starting pose: ${act.start}. ` +
      `The action "${act.action}" has NOT started: do not show it in progress or completed, and leave clear room in the frame for it and for its destination (${act.end}). ` +
      `Scene constraints: ${act.constraints.join("; ")}.`
    : "This frame is the FIRST frame of a short animated shot: pose the subject just before its action.";
  const prompt =
    `${input.bible.style}. Scene: ${clean(input.concept, 160)}. ${input.bible.text} ` +
    `Story context (do not render as text): "${clean(input.narration, 280)}". ` +
    "Vertical 9:16 composition, main subject fully visible in the upper two thirds, bottom third calm and free of key details, no text or lettering. " +
    firstFrame;
  const key = createHash("sha256").update(`anim-base\n${prompt}\n${negative}`).digest("hex").slice(0, 12);
  return { prompt, negativePrompt: negative, key };
}

/** Ritmo de la acción según la energía de la escena (la acción en sí la declara el guion). */
const PACE_BY_ENERGY: Record<SceneEnergy, string> = {
  low: "slow and subtle",
  medium: "natural, moderate pace",
  high: "fast and decisive",
};

/**
 * Segundos visibles mínimos para que una acción se entienda completa (una
 * acción lenta necesita más). Si el plano visible es más corto, se bloquea
 * antes de pagar el clip: nunca se acelera ni se congela para disimularlo.
 */
export const MIN_ACTION_SECONDS: Record<SceneEnergy, number> = { low: 2.5, medium: 2.0, high: 1.5 };

/** Margen entre el término de la acción y el corte del plano: la acción nunca termina justo en el corte. */
export const ACTION_CLOSING_MARGIN_SECONDS = 0.3;

/**
 * Segundos visibles que exige una escena: el mínimo de su acción MÁS el
 * margen de cierre. Es el único criterio, usado en la estimación previa,
 * con los tiempos reales de la voz y en el plan del clip.
 */
export function requiredVisibleSeconds(energy: SceneEnergy): number {
  return (Math.round(MIN_ACTION_SECONDS[energy] * 10) + Math.round(ACTION_CLOSING_MARGIN_SECONDS * 10)) / 10;
}

/** Segundos visibles declarables: truncados a décimas, para no anunciar nunca un corte posterior al real. */
export function declarableVisibleSeconds(seconds: number): number {
  return Math.floor(seconds * 10 + 1e-6) / 10;
}

/** ¿Cabe la acción (mínimo + margen de cierre) en lo que se ve del plano? */
export function actionFitsVisible(visibleSeconds: number, energy: SceneEnergy): boolean {
  return declarableVisibleSeconds(visibleSeconds) + 1e-9 >= requiredVisibleSeconds(energy);
}

/**
 * Escenas cuya narración, al ritmo habitual de la voz, se vería menos que
 * el mínimo de su acción más el margen de cierre. Es una ESTIMACIÓN antes
 * de pagar nada; la comprobación exacta ocurre con los tiempos reales de la
 * voz, antes del primer clip, con el mismo criterio (actionFitsVisible).
 */
export function scenesTooShortForAction(scenes: { text: string }[], sceneEnergy: (SceneEnergy | undefined)[] = []): number[] {
  return scenes
    .map((s, i) => (actionFitsVisible(s.text.split(/\s+/).filter(Boolean).length / WORDS_PER_SECOND, sceneEnergy[i] ?? "medium") ? -1 : i))
    .filter((i) => i >= 0);
}

/** Escenas sin acción visible declarada (obligatoria para animar). */
export function scenesMissingAction(scenes: { visibleAction?: string }[]): number[] {
  return scenes.map((s, i) => (s.visibleAction && s.visibleAction.trim().length >= 3 ? -1 : i)).filter((i) => i >= 0);
}

const CAMERA_BY_INTENT: Record<IntentId, string> = {
  suspense: "static camera or a very slow push-in",
  humor: "static camera, the action carries the shot",
  uplifting: "slow gentle push-in or rise",
  informative: "static camera or slow lateral drift",
  reflective: "static camera or very slow pull-back",
  action: "camera may follow the action smoothly, no whip pans",
};

/** Escena del Reel animada: todo lo que el clip debe respetar, declarado explícitamente. */
export type SceneAnimationSpec = {
  sceneIndex: number;
  narration: string;
  subject: string;
  /** Acción visible concreta declarada para la escena (guion o revisión). */
  action: string;
  /** Segundos del clip que se ven en el montaje: la acción debe completarse dentro de ellos. */
  visibleSeconds: number;
  startState: string;
  endState: string;
  /** Ilustración base de ESTA escena (ruta en Storage): la imagen de entrada real del clip. */
  referenceImagePath: string;
  constants: string[];
  framing: string;
  camera: string;
  prompt: string;
  negativePrompt: string;
  /** Huella de todo lo que determina el clip (imagen de entrada, instrucciones, modelo y parámetros). */
  key: string;
  choreography: ActionPlan;
};

export const ANIMATION_NEGATIVE =
  "text, captions, subtitles, letters, logos, watermark, speech, talking, dialogue, lip sync, singing, music, scene cuts, " +
  "change of art style, photorealism change, morphing, melting shapes, extra limbs, distorted faces, new characters appearing";

export class AnimationPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnimationPlanError";
  }
}

export function planSceneAnimation(input: {
  sceneIndex: number;
  segment: Pick<ScriptScene, "text" | "visualQuery" | "visualConcepts" | "visibleAction" | "actionStart" | "actionEnd">;
  energy: SceneEnergy;
  intent: IntentId;
  bible: ContinuityBible;
  referenceImagePath: string;
  /** Huella de la ilustración base (su clave de caché): un cambio de imagen produce otro clip. */
  referenceImageKey: string;
  /** Segundos del plano que se ven en el montaje (el resto del clip se recorta). */
  visibleSeconds: number;
}): SceneAnimationSpec {
  const declared = input.segment.visibleAction?.trim();
  if (!declared || declared.length < 3) {
    throw new AnimationPlanError(`La escena ${input.sceneIndex + 1} no declara una acción visible concreta; no se anima sin ella.`);
  }
  const visibleSeconds = declarableVisibleSeconds(input.visibleSeconds);
  const minimum = MIN_ACTION_SECONDS[input.energy];
  const required = requiredVisibleSeconds(input.energy);
  if (!actionFitsVisible(input.visibleSeconds, input.energy)) {
    throw new AnimationPlanError(
      `La escena ${input.sceneIndex + 1} solo se ve ${visibleSeconds.toFixed(1)} s y su acción necesita ${required.toFixed(1)} s ` +
        `(${minimum.toFixed(1)} s de acción + ${ACTION_CLOSING_MARGIN_SECONDS.toFixed(1)} s de margen antes del corte). ` +
        "Alarga o une la escena en la revisión del guion; no se acelera ni se congela para disimularlo.",
    );
  }
  if (input.visibleSeconds > REEL_ANIMATION.clipSeconds + 1e-6) {
    throw new AnimationPlanError(`La escena ${input.sceneIndex + 1} se ve ${input.visibleSeconds.toFixed(1)} s, más que un clip de ${REEL_ANIMATION.clipSeconds} s.`);
  }
  const narration = clean(input.segment.text, 280);
  const subject = clean(input.segment.visualConcepts?.[0] ?? input.segment.visualQuery, 120);
  const choreography = planSceneAction(input.segment);
  const action = choreography.action;
  // Siempre ≥ minimum (garantizado por actionFitsVisible) y siempre 0,3 s antes del corte declarado.
  const completeBy = (Math.round(visibleSeconds * 10) - Math.round(ACTION_CLOSING_MARGIN_SECONDS * 10)) / 10;
  const startState = `exactly the input image (${choreography.start}); the action has not started`;
  const endState = `${choreography.end}, reached by second ${completeBy.toFixed(1)} and held unchanged until the cut`;
  const { negatives } = sceneConstraints([input.segment.text, input.segment.visualQuery, ...(input.segment.visualConcepts ?? []), action, input.segment.actionStart, input.segment.actionEnd]);
  const negativePrompt = [ANIMATION_NEGATIVE, "reversing the action, undoing the action, repeating the action, looping motion", ...negatives].join(", ");
  const framing =
    "the illustration is centered; blurred bands above and below it are background and must stay still; keep the whole subject inside the illustration area, in its upper two thirds; keep the bottom third free for subtitles";
  const camera = CAMERA_BY_INTENT[input.intent];
  const prompt =
    `Animate this illustration with real motion inside the scene. Subject: ${subject}. ` +
    `The ONLY visible action: ${action} (${PACE_BY_ENERGY[input.energy]}). Story moment (do not render as text): "${narration}". ` +
    `Timing: the action starts immediately and is fully completed by second ${completeBy.toFixed(1)}; the shot is cut at second ${visibleSeconds.toFixed(1)}, so nothing important may happen after that. ` +
    `Sequence: starts as ${startState}; ends with ${endState}. Once the final state is reached it stays exactly so: nothing reverses, reopens, repeats or loops; only subtle ambient motion remains. ` +
    `Scene constraints: ${choreography.constraints.join("; ")}. ` +
    `Camera: ${camera}. Single continuous shot, no cuts. Framing: ${framing}. ` +
    `${input.bible.text} Do not change the drawing style of the input image. No speech, no dialogue, no music.`;
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        model: REEL_ANIMATION.model,
        resolution: REEL_ANIMATION.resolution,
        aspect: REEL_ANIMATION.aspectRatio,
        seconds: REEL_ANIMATION.clipSeconds,
        image: input.referenceImageKey,
        prompt,
        negative: negativePrompt,
      }),
    )
    .digest("hex")
    .slice(0, 12);
  return {
    sceneIndex: input.sceneIndex,
    narration,
    subject,
    action,
    visibleSeconds,
    startState,
    endState,
    referenceImagePath: input.referenceImagePath,
    constants: input.bible.constants,
    framing,
    camera,
    prompt,
    negativePrompt,
    key,
    choreography,
  };
}

export function animatedClipObjectPrefix(sceneIndex: number, key: string): string {
  return `scene-${sceneIndex}-anim-${key}`;
}

/**
 * Montaje del modo animación: UN plano continuo por escena (el clip), sin
 * zoom añadido («hold»), cubriendo exactamente la narración. Un plano que
 * necesite más segundos que el clip se rechaza: nunca se congela el último
 * fotograma ni se ralentiza para rellenar.
 */
export function planAnimatedShots(input: {
  sceneSpans: { start: number; end: number }[];
  transitionInFrames: number;
  fps: number;
  clipSeconds?: number;
  /** Energía por escena: fija los segundos visibles mínimos para que su acción se complete. */
  sceneEnergy?: SceneEnergy[];
}): {
  shots: { sceneIndex: number; beatIndex: number; startSeconds: number; endSeconds: number; motion: "hold"; transitionInFrames: number }[];
  tooLong: { sceneIndex: number; neededSeconds: number }[];
  /** requiredSeconds = mínimo de la acción + margen de cierre. */
  tooShort: { sceneIndex: number; visibleSeconds: number; minimumSeconds: number; requiredSeconds: number }[];
} {
  const clipSeconds = input.clipSeconds ?? REEL_ANIMATION.clipSeconds;
  const shots = input.sceneSpans.map((span, i) => {
    const prev = input.sceneSpans[i - 1];
    const limit = prev ? Math.floor((Math.min(prev.end - prev.start, span.end - span.start) * input.fps) / 2) : 0;
    return {
      sceneIndex: i,
      beatIndex: 0,
      startSeconds: span.start,
      endSeconds: span.end,
      motion: "hold" as const,
      transitionInFrames: i === 0 ? 0 : Math.max(0, Math.min(input.transitionInFrames, limit)),
    };
  });
  const tooLong = shots
    .map((s, i) => ({ sceneIndex: s.sceneIndex, neededSeconds: s.endSeconds - s.startSeconds + (shots[i + 1]?.transitionInFrames ?? 0) / input.fps }))
    .filter((x) => x.neededSeconds > clipSeconds + 1e-6);
  const tooShort = shots
    .filter((s) => !actionFitsVisible(s.endSeconds - s.startSeconds, input.sceneEnergy?.[s.sceneIndex] ?? "medium"))
    .map((s) => {
      const energy = input.sceneEnergy?.[s.sceneIndex] ?? "medium";
      return { sceneIndex: s.sceneIndex, visibleSeconds: s.endSeconds - s.startSeconds, minimumSeconds: MIN_ACTION_SECONDS[energy], requiredSeconds: requiredVisibleSeconds(energy) };
    });
  return { shots, tooLong, tooShort };
}
