/**
 * Validación REAL, acotada, del proveedor de imágenes de OpenAI —
 * exactamente UNA imagen, pasando por `openaiImageProvider` (la
 * abstracción real, `src/lib/providers/image/openai.ts`), nunca por un
 * fetch suelto que la evite. No toca Supabase, no genera video, no llama
 * a ningún otro proveedor de pago.
 *
 * La escena usada es una StoryboardScene real (validada contra
 * StoryboardSceneSchema, el mismo contrato que usa el Visual Director en
 * producción) para el concepto "La disciplina te lleva más lejos que la
 * motivación" — el mismo tema que ya usa scripts/dry-run-storyboard.ts
 * por defecto. Los campos de composición (imagePrompt/negativePrompt/
 * subject/visibleAction/environment/lighting/...) fueron escritos A MANO
 * siguiendo el brief cinematográfico exacto pedido para esta validación
 * (persona levantándose antes del amanecer para entrenar, pareja dormida,
 * luz fría de amanecer, zapatillas junto a la puerta) — NO vienen de una
 * llamada real a Claude, porque esta validación tiene expresamente
 * prohibido llamar a cualquier proveedor de pago que no sea OpenAI. Se
 * valida igualmente contra el schema real para probar que es una escena
 * válida del contrato del Visual Director, no un prompt inventado suelto.
 *
 * Uso: npx tsx scripts/validate-openai-image.ts
 * Requiere: OPENAI_API_KEY, IMAGE_PROVIDER=openai (o se fuerza igual, ver
 * abajo — este script importa openaiImageProvider directamente, no pasa
 * por el selector getImageProvider(), precisamente para no arriesgarse a
 * caer al fixture en silencio en una validación que debe ser real).
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";

export {};

async function main() {
  const { StoryboardSceneSchema, validateStoryboard } = await import("../src/lib/video/storyboard/types");
  const { openaiImageProvider } = await import("../src/lib/providers/image/openai");
  const { validatePhotoBuffer } = await import("../src/lib/video/avatar/photo-validation");

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Falta OPENAI_API_KEY — esta validación debe ser real, no cae a ningún fixture.");
  }

  const scene = {
    id: "scene-0-openai-validation",
    order: 0,
    narrationText: "La disciplina te lleva más lejos que la motivación.",
    estimatedDurationSeconds: 3.5,
    literalMeaning: "La disciplina sostiene la acción incluso cuando la motivación no aparece.",
    emotionalSubtext: "Determinación silenciosa, sin necesidad de inspiración externa.",
    narrativeGoal: "gancho inicial — instalar la idea central del video con una sola imagen",
    dominantEmotion: "disciplina silenciosa",
    energy: "low" as const,
    subject: "a person in their late 20s getting up before dawn to train, while their partner remains asleep",
    visibleAction:
      "one person quietly sits up and rises from bed just before sunrise, pulling on training clothes, while another person remains peacefully asleep in the same bed",
    environment: "bedroom with a window facing the sunrise",
    timeOfDay: "before dawn",
    shotType: "medium shot, shallow depth of field",
    cameraMovement: "static, locked-off",
    lighting: "cold pale blue-gray pre-dawn light through a window, soft long shadows",
    colorPalette: "desaturated cool blues and grays with one small warm accent (bedside lamp)",
    visualStyle: "cinematic, photorealistic, shot on 35mm, not stylized or illustrated",
    imagePrompt:
      "Cinematic photorealistic vertical portrait composition for a short-form social video (9:16 framing). " +
      "A disciplined person in their late twenties quietly getting out of bed just before sunrise, sitting on " +
      "the edge of the bed pulling on training clothes, while their partner remains peacefully asleep in the " +
      "same bed in the soft background. Cold, pale blue-gray dawn light spills through a window, casting long " +
      "soft shadows across the bedroom. A pair of worn running shoes sits neatly by the bedroom door, ready and " +
      "waiting. Medium shot, shallow depth of field, natural window lighting only, desaturated cool color " +
      "palette with a single warm accent from a bedside lamp. Mood: silent discipline, quiet determination, " +
      "resolve, quiet progress — not triumphant, not dramatic, just resolute. Photorealistic, cinematic film " +
      "still, shot on a 35mm lens, realistic skin texture, natural anatomy, correct hands. Leave clear, mostly " +
      "empty negative space in the upper third and lower third of the frame for caption overlays added later.",
    negativePrompt:
      "text, letters, words, captions, subtitles, watermark, logo, brand marks, user interface elements, app " +
      "icons, illustration, cartoon, anime, painting, 3d render, deformed hands, extra fingers, missing " +
      "fingers, malformed limbs, distorted face, unrealistic anatomy, oversaturated colors, motivational " +
      "poster text, stock photo watermark",
    stockQueries: [
      "person waking up early to exercise",
      "sunrise workout discipline motivation",
      "running shoes by bedroom door morning",
      "partner sleeping while other person gets up to train",
    ],
    resourceType: "generated_image" as const,
    priority: 1,
    confidence: 0.6,
    selectionRationale:
      "Escena escrita a mano para esta validación puntual (ver comentario de cabecera del script) — no generada " +
      "por una llamada real a Claude, que está fuera de alcance de esta prueba. La confianza (0.6, no 0.9+) " +
      "refleja precisamente eso: es una redacción manual siguiendo el brief, no un análisis semántico real del " +
      "Visual Director.",
    continuityWithPrevious: "none",
    continuityWithNext: "none",
    maxCostUsd: 1,
    fallbackStrategy: ["retry_prompt", "alternate_provider", "validated_stock", "motion_graphic"] as const,
  };

  // Paso 1: probar que es una escena VÁLIDA del contrato del Visual
  // Director (no un prompt inventado suelto) antes de gastar nada.
  const schemaResult = StoryboardSceneSchema.safeParse(scene);
  if (!schemaResult.success) {
    throw new Error(
      `La escena de prueba no cumple StoryboardSceneSchema — no se llama a OpenAI: ${JSON.stringify(schemaResult.error.issues)}`,
    );
  }
  const fullStoryboardCheck = validateStoryboard({
    visualIdentity: {
      characterAgeAndAppearance: "adult in their late 20s, athletic build, no other recurring characters yet established",
      wardrobe: "simple sleepwear transitioning to training clothes",
      place: "a modest bedroom",
      colorPalette: "desaturated cool blues and grays with warm accents",
      lighting: "natural, pre-dawn and dawn light",
      realismLevel: "photorealistic cinematic, not stylized or illustrated",
      aspectRatio: "9:16",
      emotionalTone: "quiet discipline and resolve",
      narrativeArc: "de la quietud del amanecer a la acción decidida",
    },
    hookDescription: "Alguien se levanta en silencio antes del amanecer mientras otra persona sigue dormida — disciplina sin espectáculo.",
    closingDescription: "no aplica a esta validación de una sola escena",
    scenes: [scene],
  });
  if (!fullStoryboardCheck.valid) {
    throw new Error(`El storyboard completo no valida: ${JSON.stringify(fullStoryboardCheck.errors)}`);
  }

  console.log(
    "[validate-openai-image] escena válida contra StoryboardSceneSchema — procediendo con la llamada real a OpenAI",
  );

  const startedAt = Date.now();
  const asset = await openaiImageProvider.generateImage({
    prompt: scene.imagePrompt,
    negativePrompt: scene.negativePrompt,
    aspectRatio: "9:16",
    maxCostUsd: 1,
  });
  const latencyMs = Date.now() - startedAt;

  // Paso 2: validar el archivo devuelto como un archivo de imagen real
  // (firma mágica + dimensiones), reutilizando el mismo validador que ya
  // usa el modo avatar para fotografías subidas por usuarios — no se
  // asume que "la llamada no lanzó error" ya implica "es una imagen real
  // y válida".
  const fileValidation = validatePhotoBuffer(asset.buffer, asset.mimeType);

  const outputPath = path.join(process.cwd(), "openai-image-validation-output.png");
  await writeFile(outputPath, asset.buffer);

  const report = {
    provider: "openai",
    model: asset.model,
    sizeRequested: process.env.OPENAI_IMAGE_SIZE || "1024x1536 (default)",
    qualityRequested: process.env.OPENAI_IMAGE_QUALITY || "medium (default)",
    maxRetriesConfigured: process.env.OPENAI_IMAGE_MAX_RETRIES ?? "1 (default)",
    latencyMs,
    costUsd: asset.costUsd,
    bufferBytes: asset.buffer.byteLength,
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
    fileValidation,
    outputPath,
    schemaValidation: "OK — la escena de prueba cumple StoryboardSceneSchema/StoryboardSchema",
  };

  console.log("[validate-openai-image] RESULTADO", JSON.stringify(report, null, 2));

  if (!fileValidation.valid) {
    throw new Error(`La imagen devuelta por OpenAI no pasó la validación de archivo: ${fileValidation.reason}`);
  }
}

main().catch((err) => {
  console.error("[validate-openai-image] FALLÓ:", err instanceof Error ? err.message : err);
  process.exit(1);
});
