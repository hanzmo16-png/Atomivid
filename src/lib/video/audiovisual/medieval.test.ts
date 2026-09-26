/**
 * «Medieval oscuro» y la preparación de acciones de «Animación IA»:
 * estilo, independencia estilo/movimiento, pose inicial, estado final
 * sostenido y restricciones por escena (hallazgos de las muestras reales:
 * guardián que ya miraba la ventana, puerta que volvía a abrirse, faro con
 * llamas no pedidas). Sin red ni gasto.
 */
process.env.AUDIOVISUAL_STORAGE_RETRY_MS = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PROFILES, PROFILE_IDS, parseSelection, previewSummary } from "./catalog";
import { resolveDirection } from "./direction";
import { buildStyledImagePrompt, reelLookFor } from "./visuals";
import {
  ACTION_CLOSING_MARGIN_SECONDS,
  buildAnimationBaseImagePrompt,
  buildContinuityBible,
  planSceneAction,
  planSceneAnimation,
  sceneConstraints,
} from "./animation";
import { memoryStorage } from "./test-storage";
import type { GeneratedScript, VideoProvider } from "@/lib/providers/types";
import type { Scene } from "../../../../remotion/VerticalReel";

test("Medieval oscuro: perfil propio en el selector, estilo realista oscuro sin imponer caballos, batallas ni clima", () => {
  assert.ok(PROFILE_IDS.includes("medieval_dark"));
  const p = PROFILES.medieval_dark;
  assert.equal(p.label, "Medieval oscuro");
  assert.equal(p.visualSource, "generated_image");
  for (const word of ["medieval", "black", "steel grey", "sepia", "desaturated", "metal", "stone", "leather", "fabrics"]) {
    assert.match(p.imageStyle!, new RegExp(word), word);
  }
  for (const imposed of ["horse", "battle", "war", "fog", "rain", "wind", "dust", "snow"]) {
    assert.doesNotMatch(p.imageStyle!, new RegExp(imposed, "i"), `el estilo no impone ${imposed}`);
  }
  for (const banned of ["text", "film frame", "film border", "letterbox"]) assert.match(p.imageNegative!, new RegExp(banned));
  assert.equal(p.intentPreset, undefined, "la emoción la marca la historia");
  const prompt = buildStyledImagePrompt({ profile: "medieval_dark", intent: "reflective", concept: "old stone chapel", narration: "La capilla quedó en silencio." });
  assert.match(prompt.prompt, /dark medieval fantasy/);
  assert.match(prompt.negativePrompt, /film frame/);
  assert.ok(reelLookFor("medieval_dark", "suspense"));
});

test("Medieval oscuro: estilo y movimiento son independientes y se persisten como cualquier perfil", () => {
  const images = parseSelection({ profile: "medieval_dark" });
  const anim = parseSelection({ profile: "medieval_dark", motion: "ai_animation" });
  assert.ok(images.ok && images.selection.motion === undefined);
  assert.ok(anim.ok && anim.selection.motion === "ai_animation");
  assert.ok(parseSelection({ profile: "medieval_dark", intent: "humor", music: "playful" }).ok, "sin intención fija");
  assert.match(previewSummary({ version: 1, profile: "medieval_dark", motion: "ai_animation" }, "Curiosidades"), /animación IA$/);
  const scenes = [{ text: "El caballero cruzó el puente.", visualQuery: "knight crossing bridge", energy: "medium" as const }];
  const a = resolveDirection({ selection: { version: 1, profile: "medieval_dark" }, style: "Curiosidades", topic: "El puente", scenes });
  const b = resolveDirection({ selection: { version: 1, profile: "medieval_dark", motion: "ai_animation" }, style: "Curiosidades", topic: "El puente", scenes });
  assert.equal(a.profile, "medieval_dark");
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test("restricciones de escena: lo que la escena no menciona no aparece (el faro no gana llamas ni destellos)", () => {
  const lighthouse = sceneConstraints(["La luz del faro barrió el mar en calma.", "old lighthouse at night", "the lighthouse beam sweeps once across the sea"]);
  assert.ok(lighthouse.constraints.includes("no fire or flames"));
  assert.ok(lighthouse.constraints.includes("no flashes, sparks or lightning"));
  assert.ok(lighthouse.constraints.includes("no fog or mist"));
  assert.ok(lighthouse.negatives.includes("fire, flames"));
  const horse = sceneConstraints(["El caballero avanzó levantando polvo y pequeñas piedras.", "hooves kicking up dust and small stones"]);
  assert.ok(!horse.constraints.includes("no dust or flying debris"), "el polvo pedido se permite");
  assert.ok(horse.constraints.includes("no rain"));
  const fog = sceneConstraints(["La niebla avanzó por la escalera."]);
  assert.ok(!fog.constraints.includes("no fog or mist"));
  assert.ok(fog.constraints.some((c) => /no new characters/.test(c)));
});

const bible = buildContinuityBible({ profile: "medieval_dark", intent: "suspense", topic: "La torre", scenes: [{ visualQuery: "stone tower" }] });

test("pose inicial: la ilustración base muestra el momento ANTERIOR a la acción (el guardián aún no mira la ventana)", () => {
  const segment = {
    text: "El guardián giró de golpe hacia la ventana rota.",
    visualQuery: "keeper turning to broken window",
    visibleAction: "the keeper turns his head sharply toward the window",
    actionStart: "the keeper faces the stairs, his back to the window",
    actionEnd: "the keeper stares at the broken window, still",
  };
  const act = planSceneAction(segment);
  assert.equal(act.declaredStart, true);
  const base = buildAnimationBaseImagePrompt({ profile: "medieval_dark", bible, concept: segment.visualQuery, narration: segment.text, action: act });
  assert.match(base.prompt, /Show exactly this starting pose: the keeper faces the stairs, his back to the window/);
  assert.match(base.prompt, /has NOT started: do not show it in progress or completed/);
  assert.match(base.prompt, /destination \(the keeper stares at the broken window, still\)/);
  const other = buildAnimationBaseImagePrompt({ profile: "medieval_dark", bible, concept: segment.visualQuery, narration: segment.text, action: planSceneAction({ ...segment, actionStart: "the keeper kneels by the lamp" }) });
  assert.notEqual(other.key, base.key, "otra pose inicial → otra ilustración");
  // Sin pose declarada: formulación explícita genérica, nunca una pose inventada.
  const generic = planSceneAction({ ...segment, actionStart: undefined, actionEnd: undefined });
  assert.equal(generic.declaredStart, false);
  assert.match(generic.start, /has not started yet/);
  assert.match(generic.end, /stays still/);
  assert.throws(() => planSceneAction({ ...segment, visibleAction: " " }));
});

test("estado final sostenido: la puerta cerrada no vuelve a abrirse; el margen de 0,3 s se conserva", () => {
  const spec = planSceneAnimation({
    sceneIndex: 0,
    segment: {
      text: "De pronto, la puerta de hierro se cerró de un golpe.",
      visualQuery: "iron door slamming shut",
      visibleAction: "the heavy iron door swings and slams shut",
      actionStart: "the heavy iron door stands half open",
      actionEnd: "the iron door stays fully shut",
    },
    energy: "high",
    intent: "suspense",
    bible,
    referenceImagePath: "req/a.png",
    referenceImageKey: "a",
    visibleSeconds: 4,
  });
  assert.match(spec.endState, /the iron door stays fully shut, reached by second 3\.7 and held unchanged until the cut/);
  assert.match(spec.prompt, /nothing reverses, reopens, repeats or loops/);
  assert.match(spec.prompt, /fully completed by second 3\.7; the shot is cut at second 4\.0/);
  assert.equal(ACTION_CLOSING_MARGIN_SECONDS, 0.3);
  assert.match(spec.negativePrompt, /reversing the action/);
  assert.match(spec.negativePrompt, /fire, flames/);
  assert.match(spec.prompt, /Scene constraints: [^.]*no fire or flames/);
  assert.equal(spec.choreography.end, "the iron door stays fully shut");
});

test("prueba del caballero: patas, jinete y suelo en cuadro; polvo y piedras permitidos; 8 s visibles con término en 7,7 s", () => {
  const segment = {
    text: "El caballero avanzó por el camino de tierra, levantando polvo y pequeñas piedras.",
    visualQuery: "armored knight riding horse on dirt road",
    visualConcepts: ["original armored knight riding a dark warhorse along a stony dirt road, the whole horse with all four legs and hooves, the rider and the ground in frame"],
    visibleAction: "the knight rides his horse forward at a steady trot",
    actionStart: "the horse stands on the road with one front hoof lifted, ready to step",
    actionEnd: "horse and knight keep trotting forward, fully in frame, hooves kicking up dust and small stones",
  };
  const spec = planSceneAnimation({ sceneIndex: 0, segment, energy: "medium", intent: "action", bible, referenceImagePath: "req/h.png", referenceImageKey: "h", visibleSeconds: 8 });
  assert.match(spec.prompt, /fully completed by second 7\.7; the shot is cut at second 8\.0/);
  assert.doesNotMatch(spec.negativePrompt, /dust clouds/);
  assert.match(spec.subject, /all four legs and hooves/);
});

// ---------- Recorrido del pipeline con el mismo código de producto (proveedores simulados) ----------

const FIXTURES = { SCRIPT_PROVIDER: "fixture", VOICE_PROVIDER: "fixture", FOOTAGE_PROVIDER: "fixture", IMAGE_PROVIDER: "fixture", MUSIC_PROVIDER: "fixture", OPENAI_IMAGE_GENERATION_ENABLED: "true" };

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(64, 1)]);

const MEDIEVAL: GeneratedScript = {
  title: "La torre",
  segments: [
    { text: "Nadie volvió de la torre del norte desde aquel invierno sin nombre.", visualQuery: "ruined stone tower", energy: "low", visibleAction: "a crow lands on the broken battlement", actionStart: "the empty battlement, a crow gliding toward it", actionEnd: "the crow stays perched, still" },
    { text: "El caballero empujó la puerta de roble y entró con cautela en la sala.", visualQuery: "knight opening oak door", energy: "medium", visibleAction: "the knight pushes the oak door open", actionStart: "the knight stands before the closed oak door", actionEnd: "the door stays open, the knight on the threshold" },
  ],
};

test("pipeline: Medieval oscuro llega al generador de imágenes (y en animación, la pose inicial llega a la ilustración base)", async () => {
  const { generateDirectedVideoFromScript } = await import("./directed-reel");
  const s = memoryStorage();
  const received: { scenes: Scene[] }[] = [];
  const render = async (props: { scenes: Scene[] }) => {
    received.push(props);
    const out = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "atomivid-med-")), "reel.mp4");
    await fs.writeFile(out, MP4);
    return out;
  };
  const clipCalls: string[] = [];
  const fakeVeo: VideoProvider = {
    name: "veo",
    capabilities: { id: "veo", models: ["m"], formats: ["video/mp4"], aspectRatios: ["9:16"], timeoutMs: 0, maxRetries: 0 },
    isAvailable: () => true,
    async generateVideo(request) {
      clipCalls.push(request.prompt);
      await request.onProviderJobAccepted?.("op-1");
      return { buffer: MP4, mimeType: "video/mp4", extension: "mp4", durationSeconds: 8, model: "m", costUsd: 0.96, providerJobId: "op-1" };
    },
    async resumeGeneration() {
      throw new Error("no se espera reanudación");
    },
  };
  let direction: ReturnType<typeof resolveDirection> | undefined;
  await withEnv({ ...FIXTURES, REEL_AI_ANIMATION_ENABLED: "true", MAX_AI_ANIMATION_COST_USD: "5", MAX_VISUAL_COST_USD: "1" }, async () => {
    direction = resolveDirection({ selection: { version: 1, profile: "medieval_dark", motion: "ai_animation" }, style: "Curiosidades", topic: "La torre", scenes: MEDIEVAL.segments });
    await generateDirectedVideoFromScript({ supabase: s.client, requestId: "req-med", topic: "La torre", script: MEDIEVAL, direction, deps: { animationProvider: fakeVeo, renderReel: render as never } });
  });
  assert.equal(clipCalls.length, 2);
  assert.ok(clipCalls.every((p) => /Scene constraints:/.test(p) && /nothing reverses, reopens, repeats or loops/.test(p)));
  assert.match(clipCalls[1], /the door stays open, the knight on the threshold/);
  assert.ok(received[0].scenes.every((sc) => sc.mediaType === "video"));
  // La ruta de cada ilustración base lleva la huella del prompt: coincide con el prompt que incluye la pose inicial de la escena.
  const pipelineBible = buildContinuityBible({ profile: "medieval_dark", intent: direction!.intent.id, topic: "La torre", scenes: MEDIEVAL.segments });
  MEDIEVAL.segments.forEach((seg, i) => {
    const expected = buildAnimationBaseImagePrompt({ profile: "medieval_dark", bible: pipelineBible, concept: seg.visualQuery, narration: seg.text, action: planSceneAction(seg) });
    assert.ok([...s.files.keys()].some((k) => k.includes(`scene-${i}-animbase-${expected.key}`)), `escena ${i + 1}: ilustración base con su pose inicial`);
    assert.match(expected.prompt, new RegExp(`starting pose: ${seg.actionStart}`));
  });
});
