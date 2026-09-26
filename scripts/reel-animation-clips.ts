/**
 * Primera prueba REAL de «Animación IA»: solo clips cortos (sin guion, voz,
 * música ni render del Reel), para comprobar movimiento real y conservación
 * del dibujo antes de animar un Reel completo. PREPARADO, NO EJECUTADO.
 *
 * Modos (MODE):
 *  - plan (por defecto): no llama a ningún proveedor; imprime clips,
 *    segundos facturables, costo y máximo con reintentos.
 *  - run: exige ANIMATION_ALLOW_PAID=true, credenciales de Supabase y
 *    ANIMATION_TOTAL_USD (tope autorizado). Cada ilustración nueva y cada
 *    clip se reservan en un registro durable
 *    (<ANIMATION_LEDGER_SCOPE>/state/paid-ledger.json; por defecto
 *    samples/animation-medieval, separado del de las muestras de Work) ANTES de llamar; un
 *    reintento reutiliza lo guardado, reanuda una operación ya enviada y se
 *    detiene ante cualquier cobro incierto.
 *
 * Clip por defecto (ANIMATION_CLIPS): medieval-horse. Las cuatro muestras
 * ya generadas (comic-*, anime-*) no se repiten salvo ANIMATION_REPEAT_GENERATED=true. Una ilustración existente puede reutilizarse
 * con ANIMATION_INPUT_<ID>=<ruta en Storage> (p. ej. las del Cómic de la
 * muestra real); si no, se genera una nueva con el estilo del perfil.
 */
import { createHash } from "node:crypto";

type ClipCase = {
  id: string;
  profile: "comic" | "anime" | "medieval_dark";
  intent: "suspense" | "action";
  energy: "low" | "medium" | "high";
  topic: string;
  segment: { text: string; visualQuery: string; visualConcepts?: string[]; visibleAction: string; actionStart?: string; actionEnd?: string };
  /** Segundos del clip que se verían en el Reel: la acción debe completarse dentro de ellos. */
  visibleSeconds: number;
};

// Las cuatro primeras ya se generaron (runs 36256727335 y 36257549360 sobre
// 3b5716b); se conservan como referencia, no se repiten. «medieval-horse» es
// la prueba de coordinación de Medieval oscuro (patas, jinete y suelo).
const GENERATED = new Set(["comic-subtle", "comic-action", "anime-subtle", "anime-action"]);

const CASES: ClipCase[] = [
  {
    id: "comic-subtle",
    profile: "comic",
    intent: "suspense",
    energy: "low",
    topic: "El faro",
    segment: { text: "La luz del faro parpadeó una última vez sobre el mar en calma.", visualQuery: "old lighthouse at night", visualConcepts: ["old lighthouse at night", "lighthouse beam over dark sea"], visibleAction: "the lighthouse beam sweeps once across the sea and fades out" },
    visibleSeconds: 5,
  },
  {
    id: "comic-action",
    profile: "comic",
    intent: "suspense",
    energy: "high",
    topic: "El faro",
    segment: { text: "De pronto, la puerta de hierro se cerró de un golpe.", visualQuery: "iron door slamming shut", visualConcepts: ["iron door slamming shut", "lighthouse keeper startled"], visibleAction: "the heavy iron door swings and slams shut" },
    visibleSeconds: 4,
  },
  {
    id: "anime-subtle",
    profile: "anime",
    intent: "suspense",
    energy: "low",
    topic: "El faro",
    segment: { text: "La niebla avanzó lentamente por la escalera de caracol.", visualQuery: "fog on spiral stairway", visualConcepts: ["fog on spiral stairway", "dim lantern on stairs"], visibleAction: "fog creeps down three steps of the stairway" },
    visibleSeconds: 5,
  },
  {
    id: "anime-action",
    profile: "anime",
    intent: "suspense",
    energy: "high",
    topic: "El faro",
    segment: { text: "El guardián giró de golpe hacia la ventana rota.", visualQuery: "keeper turning to broken window", visualConcepts: ["keeper turning to broken window", "shattered lighthouse window"], visibleAction: "the keeper turns his head sharply toward the window" },
    visibleSeconds: 4,
  },
  {
    id: "medieval-horse",
    profile: "medieval_dark",
    intent: "action",
    energy: "medium",
    topic: "El caballero del camino",
    segment: {
      text: "El caballero avanzó por el camino de tierra, levantando polvo y pequeñas piedras.",
      visualQuery: "armored knight riding horse on dirt road",
      visualConcepts: [
        "original armored knight riding a dark warhorse along a stony dirt road, side three-quarter view, the whole horse with all four legs and hooves, the rider and the ground in frame",
        "knight on horseback on a dirt road, dust at the hooves",
      ],
      visibleAction: "the knight rides his horse forward at a steady trot",
      actionStart: "the horse stands on the road with one front hoof lifted, ready to step",
      actionEnd: "horse and knight keep trotting forward, fully in frame, hooves kicking up dust and small stones",
    },
    visibleSeconds: 8,
  },
];

async function main() {
  const { REEL_ANIMATION, animationClipCostUsd, buildAnimationBaseImagePrompt, buildContinuityBible, planSceneAction, planSceneAnimation } = await import("../src/lib/video/audiovisual/animation");
  const { IMAGE_RESERVE_USD } = await import("../src/lib/video/audiovisual/paid-costs");
  const mode = (process.env.MODE ?? "plan").trim();
  // Por defecto solo la prueba pendiente; las ya generadas nunca se repiten sin pedirlo explícitamente.
  const ids = (process.env.ANIMATION_CLIPS ?? "medieval-horse").split(",").map((s) => s.trim()).filter(Boolean);
  const alreadyGenerated = ids.filter((id) => GENERATED.has(id));
  if (alreadyGenerated.length > 0 && (process.env.MODE ?? "plan").trim() === "run" && process.env.ANIMATION_REPEAT_GENERATED !== "true") {
    throw new Error(`Ya generadas (no se repiten): ${alreadyGenerated.join(", ")}. No se llamó a ningún proveedor.`);
  }
  const selected = ids.map((id) => {
    const c = CASES.find((x) => x.id === id);
    if (!c) throw new Error(`Clip desconocido: ${id}`);
    return c;
  });
  const reuse = (id: string) => process.env[`ANIMATION_INPUT_${id.toUpperCase().replace(/-/g, "_")}`]?.trim() || null;
  const clipCost = animationClipCostUsd();
  // Cada acción debe caber en lo que se ve del clip: se comprueba aquí, antes de cualquier gasto.
  for (const c of selected) {
    const bible = buildContinuityBible({ profile: c.profile, intent: c.intent, topic: c.topic, scenes: [c.segment] });
    planSceneAnimation({ sceneIndex: 0, segment: c.segment, energy: c.energy, intent: c.intent, bible, referenceImagePath: "plan-check", referenceImageKey: "plan-check", visibleSeconds: c.visibleSeconds });
  }
  const newImages = selected.filter((c) => !reuse(c.id)).length;
  const plan = {
    model: REEL_ANIMATION.model,
    modality: "image-to-video (imagen de entrada real)",
    resolution: REEL_ANIMATION.resolution,
    aspectRatio: REEL_ANIMATION.aspectRatio,
    clips: selected.map((c) => ({ id: c.id, profile: c.profile, energy: c.energy, action: c.segment.visibleAction, visibleSeconds: c.visibleSeconds, inputImage: reuse(c.id) ?? "nueva" })),
    billableVideoSeconds: selected.length * REEL_ANIMATION.clipSeconds,
    videoUsd: Math.round(selected.length * clipCost * 100) / 100,
    newImages,
    imagesReserveUsd: Math.round(newImages * IMAGE_RESERVE_USD * 100) / 100,
    // Nada se repite solo. Margen para UNA recuperación explícita (tras revisar la consola) de un clip y de una ilustración.
    maxWithRetriesUsd: Math.round((selected.length * clipCost + clipCost + newImages * IMAGE_RESERVE_USD + (newImages > 0 ? IMAGE_RESERVE_USD : 0)) * 100) / 100,
  };
  console.log(`@@PLAN ${JSON.stringify(plan)}`);
  if (mode !== "run") {
    console.log("Modo plan: no se llamó a ningún proveedor.");
    return;
  }

  if (process.env.ANIMATION_ALLOW_PAID !== "true") throw new Error("MODE=run exige ANIMATION_ALLOW_PAID=true (autorización explícita de gasto).");
  const totalUsd = Number(process.env.ANIMATION_TOTAL_USD);
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) throw new Error("Falta ANIMATION_TOTAL_USD (tope autorizado).");
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Faltan credenciales de Supabase: sin registro durable no se gasta.");
  if (!process.env.VEO_API_KEY?.trim()) throw new Error("Falta VEO_API_KEY. No se llamó a ningún proveedor.");
  if (newImages > 0 && !process.env.OPENAI_API_KEY?.trim()) throw new Error("Falta OPENAI_API_KEY para las ilustraciones nuevas.");
  Object.assign(process.env, { ATOMIVID_RUNTIME: "production", IMAGE_PROVIDER: "openai", OPENAI_IMAGE_GENERATION_ENABLED: "true" });

  const { createServiceClient } = await import("../src/lib/supabase/service");
  const { openStorageLedger } = await import("../src/lib/video/audiovisual/paid-costs");
  const { resolveGeneratedImageForScene } = await import("../src/lib/video/visual-resource-resolver");
  const { prepareAnimationInputImage, resolveAnimatedClipForScene } = await import("../src/lib/video/audiovisual/animated-clip");
  const { getImageProvider } = await import("../src/lib/providers/image");
  const { veoVideoProvider } = await import("../src/lib/providers/video-gen/veo");
  const service = createServiceClient();
  const BUCKET = "videos";
  // Registro propio por autorización: las cuatro muestras de Work usan «samples/animation» (tope USD 5.15);
  // una prueba nueva NO debe contar ni gastar ese saldo, así que por defecto va a su propio registro.
  const scope = (process.env.ANIMATION_LEDGER_SCOPE ?? "samples/animation-medieval").trim();
  if (!/^samples\/[a-z0-9-]+$/.test(scope)) throw new Error(`ANIMATION_LEDGER_SCOPE inválido: ${scope}`);
  console.log(`[registro] ${scope}/state/paid-ledger.json, tope USD ${totalUsd}`);
  // Un solo registro para toda la prueba: el tope se aplica al acumulado de todos los clips y reintentos.
  const ledger = await openStorageLedger(service, BUCKET, scope, { capUsd: totalUsd });
  for (const c of selected) {
    const bible = buildContinuityBible({ profile: c.profile, intent: c.intent, topic: c.topic, scenes: [c.segment] });
    let base: { path: string; key: string };
    const reused = reuse(c.id);
    if (reused) {
      base = { path: reused, key: createHash("sha256").update(`reused:${reused}`).digest("hex").slice(0, 12) };
    } else {
      const prompt = buildAnimationBaseImagePrompt({ profile: c.profile, bible, concept: c.segment.visualConcepts?.[0] ?? c.segment.visualQuery, narration: c.segment.text, action: planSceneAction(c.segment) });
      const image = await resolveGeneratedImageForScene({
        supabase: service,
        bucket: BUCKET,
        requestId: `${scope}/${c.id}`,
        sceneIndex: 0,
        scene: { imagePrompt: prompt.prompt, negativePrompt: prompt.negativePrompt },
        imageProvider: getImageProvider(),
        remainingBudgetUsd: IMAGE_RESERVE_USD,
        signedUrlTtlSeconds: 3600,
        objectPrefix: `scene-0-animbase-${prompt.key}`,
        ledger,
      });
      base = { path: image.path, key: prompt.key };
    }
    const spec = planSceneAnimation({ sceneIndex: 0, segment: c.segment, energy: c.energy, intent: c.intent, bible, referenceImagePath: base.path, referenceImageKey: base.key, visibleSeconds: c.visibleSeconds });
    console.log(`@@SPEC ${JSON.stringify({ id: c.id, subject: spec.subject, action: spec.action, visibleSeconds: spec.visibleSeconds, camera: spec.camera, key: spec.key })}`);
    const input = await prepareAnimationInputImage({ supabase: service, bucket: BUCKET, requestId: `${scope}/${c.id}`, baseImagePath: base.path, objectPrefix: `scene-0-anim-${spec.key}`, signedUrlTtlSeconds: 3600 });
    const clip = await resolveAnimatedClipForScene({
      supabase: service,
      bucket: BUCKET,
      requestId: `${scope}/${c.id}`,
      spec,
      inputImage: input,
      videoProvider: veoVideoProvider,
      maxCostUsd: clipCost,
      signedUrlTtlSeconds: 3600,
      ledger,
    });
    console.log(`@@CLIP ${JSON.stringify({ id: c.id, status: clip.status, path: clip.path, operation: clip.operationName, costUsd: clip.costUsd })}`);
  }
  console.log(`@@LEDGER ${JSON.stringify(ledger.summary())}`);
}

main().catch((err) => {
  console.error("Prueba de animación detenida:", err instanceof Error ? err.message : err);
  process.exit(1);
});
