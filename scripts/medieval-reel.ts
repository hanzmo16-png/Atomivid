/**
 * Reel «Medieval oscuro» de ~30 s (4 escenas, «Animación IA» con Veo,
 * narración con la voz existente «Hans podcast», música de licencia
 * documentada y subtítulos). Guion fijo en docs/quality/medieval-reel/
 * script.json (sin llamada a Claude). Plan completo en PLAN.md.
 *
 * Modos (variable MODE):
 *  - plan (por defecto): no llama a ningún proveedor. Imprime palabras y
 *    duración estimada por escena, disponibilidad, prompts de imagen y de
 *    clip (encuadre «fill»), pista elegida y presupuesto. Con credenciales
 *    de Supabase (solo lectura): comprueba que «Hans podcast» existe y está
 *    lista, que la pista fijada está en la biblioteca y el estado del
 *    registro de gasto.
 *  - rehearsal: ensayo gratuito de extremo a extremo con proveedores
 *    simulados y un Supabase simulado sobre disco: MISMO recorrido que run
 *    (voz primero, ajuste de ritmo, pipeline de producto, evidencia).
 *  - run: gasto real. Exige REEL_ALLOW_PAID=true y el tope REEL_CAP_USD.
 *      1. resuelve «Hans podcast» (sin clonar ni modificar: solo su voice_id);
 *      2. fija la biblioteca musical a la pista con licencia documentada: si
 *         no se puede descargar, se detiene (sin otra pista);
 *      3. abre el registro durable samples/medieval-reel con el tope; una
 *         operación incierta abierta detiene todo salvo que se reconozca
 *         explícitamente (REEL_ACKNOWLEDGE="<clave>|<nota>");
 *      4. voz ANTES que imágenes y clips: con los tiempos reales comprueba
 *         que cada escena cabe en un clip de 8 s y que su acción se ve
 *         completa; si hace falta, una sola resíntesis con velocidad acotada
 *         (0,85–1,15); si aun así no cabe, se detiene sin pagar imágenes;
 *      5. pipeline de producto (directed-reel.ts) con la voz ya cacheada:
 *         imágenes, clips, render con el audio de Veo silenciado, masterizado;
 *      6. descarga el MP4, fotogramas por escena, hoja de contacto, loudness
 *         y una copia de entrega H.264 nivel 4.1 que abre en el teléfono.
 *    Sin reintentos automáticos: cualquier fallo detiene la ejecución.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GeneratedScript, ResolvedVoice } from "../src/lib/providers/types";
import type { PaidLedger } from "../src/lib/video/audiovisual/paid-ledger";

const run = promisify(execFile);
const BUCKET = "videos";
const PREFIX = "samples/medieval-reel";
const SCRIPT_PATH = "docs/quality/medieval-reel/script.json";
const STYLE = "Motivación";
const TOPIC = "a lonely stony mountain road among ruined medieval stone walls, under a heavy grey sky";
const SELECTION = { version: 1 as const, profile: "medieval_dark" as const, intent: "action" as const, music: "driving" as const, motion: "ai_animation" as const };
const VOICE_NAME = "Hans podcast";
/** Pista con procedencia y licencia documentadas (manifest.ts): la única admitida. */
const PINNED_TRACK = "pixabay-266030";
const TOTAL = { minSeconds: 25, targetSeconds: 28 };
/** Tope único propuesto (PLAN.md): imágenes + clips + voz + margen de recuperación. */
const PROPOSED_CAP_USD = 5.3;
/** Topes por tipo dentro del tope único (5 imágenes y 5 clips como máximo). */
const RUN_ENV = { MAX_VISUAL_COST_USD: "0.35", MAX_AI_ANIMATION_COST_USD: "4.80" };
const DELIVERY_NAME = "Atomivid-Medieval-Reel-01.mp4";
const DELIVERY_MAX_BYTES = 28 * 1024 * 1024;

const mode = (process.env.MODE ?? "plan").trim();
const outDir = path.resolve(process.env.REEL_OUT_DIR ?? "medieval-reel-out");
const log = (event: string, data: unknown) => console.log(`@@${event} ${JSON.stringify(data)}`);

// Banderas ANTES de importar el pipeline (se leen del entorno en cada llamada).
Object.assign(process.env, {
  REEL_AI_ANIMATION_ENABLED: "true",
  OPENAI_IMAGE_GENERATION_ENABLED: "true",
  ...RUN_ENV,
  ...(mode === "rehearsal"
    ? { SCRIPT_PROVIDER: "fixture", VOICE_PROVIDER: "fixture", FOOTAGE_PROVIDER: "fixture", MUSIC_PROVIDER: "fixture", IMAGE_PROVIDER: "fixture", REEL_ANIMATION_PROVIDER: "fixture" }
    : {}),
});

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const script = JSON.parse(await fs.readFile(SCRIPT_PATH, "utf8")) as GeneratedScript;
  const { resolveDirection } = await import("../src/lib/video/audiovisual/direction");
  const direction = resolveDirection({ selection: SELECTION, style: STYLE, topic: TOPIC, scenes: script.segments });
  if (direction.intent.id !== "action" || direction.music.id !== "driving") throw new Error(`Dirección inesperada: ${direction.summary}`);

  const plan = await buildPlan(script, direction);
  log("PLAN", plan);
  await fs.writeFile(path.join(outDir, "plan.json"), JSON.stringify(plan, null, 2));
  if (!plan.readiness.ok) throw new Error(`No está listo: ${plan.readiness.issues.join("; ")}`);
  if (!plan.music.pinnedFirst) throw new Error(`La pista elegida no es ${PINNED_TRACK} (${plan.music.candidates[0]}).`);

  if (mode === "plan") {
    const hasSupabase = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
    if (hasSupabase) {
      const service = (await import("../src/lib/supabase/service")).createServiceClient();
      const voice = await resolveHansVoice(service);
      const track = await checkPinnedTrack(service);
      const { readJsonState } = await import("../src/lib/video/audiovisual/storage-state");
      const { summarizeLedger } = await import("../src/lib/video/audiovisual/paid-ledger");
      const { ledgerPath } = await import("../src/lib/video/audiovisual/paid-costs");
      const state = await readJsonState<import("../src/lib/video/audiovisual/paid-ledger").PaidLedgerState>(service, BUCKET, ledgerPath(PREFIX), "el registro del reel");
      const ledger = state.kind === "found" ? summarizeLedger(state.data) : null;
      log("PREFLIGHT", { voice: { label: voice.label, idPrefix: voice.choice.slice(0, 15) }, track, ledger: ledger ? { committedUsd: ledger.committedUsd, openUncertainKeys: ledger.openUncertainKeys } : "vacío (nada gastado)" });
    } else {
      log("PREFLIGHT", { skipped: "sin credenciales de Supabase: voz, pista y registro no verificados" });
    }
    console.log("Modo plan: no se llamó a ningún proveedor.");
    return;
  }

  if (mode === "rehearsal") {
    const { service, close } = await diskSupabase();
    try {
      const { openStorageLedger } = await import("../src/lib/video/audiovisual/paid-costs");
      const ledger = await openStorageLedger(service, BUCKET, PREFIX, { capUsd: PROPOSED_CAP_USD });
      const result = await produce({ service, script, direction, ledger, voice: undefined, attempt: 1 });
      const local = path.join(outDir, "reel.mp4");
      await fs.writeFile(local, await downloadBuffer(service, result.videoPath));
      const evidence = await collectEvidence(local, result);
      const { verifyVideoEvidence } = await import("./lib/verify-video-evidence");
      await verifyVideoEvidence(local);
      const { verifyAnimatedMotion } = await import("./lib/verify-animated-motion");
      const motion = await verifyAnimatedMotion(local, result.shots as never);
      const crop = await fillCropEvidence();
      log("REHEARSAL", { ...evidence, motion, crop, ledger: ledger.summary() });
    } finally {
      close();
    }
    return;
  }

  if (mode !== "run") throw new Error(`MODE desconocido: ${mode}`);
  // ---- Gasto real ----
  if (process.env.REEL_ALLOW_PAID !== "true") throw new Error("MODE=run exige REEL_ALLOW_PAID=true (autorización explícita de gasto).");
  const capUsd = Number(process.env.REEL_CAP_USD);
  if (!(capUsd > 0) || capUsd > PROPOSED_CAP_USD) throw new Error(`REEL_CAP_USD debe ser > 0 y ≤ ${PROPOSED_CAP_USD} (tope propuesto).`);
  const missing = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ELEVENLABS_API_KEY", "OPENAI_API_KEY", "VEO_API_KEY", "PEXELS_API_KEY"].filter((k) => !process.env[k]?.trim());
  if (missing.length) throw new Error(`Faltan claves: ${missing.join(", ")}. No se llamó a ningún proveedor.`);
  Object.assign(process.env, {
    ATOMIVID_RUNTIME: "production", // nunca sustituir por contenido simulado
    VOICE_PROVIDER: "elevenlabs",
    IMAGE_PROVIDER: "openai",
    MUSIC_PROVIDER: "curated-library",
    FOOTAGE_PROVIDER: "pexels",
    REEL_ANIMATION_PROVIDER: "veo",
  });
  const service = (await import("../src/lib/supabase/service")).createServiceClient();
  const voice = await resolveHansVoice(service);
  log("VOICE", { label: voice.label, idPrefix: voice.choice.slice(0, 15) });
  await pinMusicLibrary();
  log("TRACK", await checkPinnedTrack(service));

  const { openStorageLedger } = await import("../src/lib/video/audiovisual/paid-costs");
  const ledger = await openStorageLedger(service, BUCKET, PREFIX, { capUsd });
  const acknowledgements = (process.env.REEL_ACKNOWLEDGE ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (acknowledgements.length > 0) {
    const { recoverPaidOperation } = await import("../src/lib/video/audiovisual/recovery");
    for (const ack of acknowledgements) {
      const [key, note] = ack.split("|");
      log("RECOVERED", await recoverPaidOperation({ supabase: service, bucket: BUCKET, ledger, key, note: note ?? "", capUsd }));
    }
  }
  const before = ledger.summary();
  log("LEDGER", { when: "inicio", ...before, runCapUsd: capUsd });
  if (before.openUncertainKeys.length > 0) throw new Error(`Operaciones inciertas abiertas: ${before.openUncertainKeys.join(", ")}. Revisar y reconocer antes de gastar.`);

  const attempt = Number((process.env.GITHUB_RUN_ID ?? String(Date.now())).slice(-9));
  const result = await produce({ service, script, direction, ledger, voice, attempt });
  if (result.trackId !== PINNED_TRACK) throw new Error(`La música usada (${result.trackId}) no es la pista fijada.`);
  const local = path.join(outDir, "reel.mp4");
  await fs.writeFile(local, await downloadBuffer(service, result.videoPath));
  const evidence = await collectEvidence(local, result);
  const { verifyVideoEvidence } = await import("./lib/verify-video-evidence");
  await verifyVideoEvidence(local);
  await downloadSceneAssets(service);
  log("RESULT", { ...evidence, ledger: ledger.summary() });
}

type Direction = import("../src/lib/video/audiovisual/direction").AudiovisualDirection;
type ProduceResult = { videoPath: string; shots: Array<Record<string, unknown>>; totalSeconds: number; speed: number | null; trackId: string | null; fit: unknown };

async function buildPlan(script: GeneratedScript, direction: Direction) {
  const { evaluateDirectionReadiness } = await import("../src/lib/video/audiovisual/readiness");
  const { getFeatureFlags } = await import("../src/lib/video/feature-flags");
  const { estimatedSceneSeconds, buildContinuityBible, buildAnimationBaseImagePrompt, planSceneAction, planSceneAnimation, animationClipCostUsd, REEL_ANIMATION } = await import(
    "../src/lib/video/audiovisual/animation"
  );
  const { IMAGE_RESERVE_USD, voiceReserveUsd, voiceCostUsd } = await import("../src/lib/video/audiovisual/paid-costs");
  const { selectDirectedTracks } = await import("../src/lib/video/audiovisual/music");
  const { MUSIC_MANIFEST } = await import("../src/lib/providers/music/manifest");
  const segments = script.segments;
  const readiness = evaluateDirectionReadiness({
    profile: direction.profile,
    music: direction.music.id,
    sceneCount: segments.length,
    flags: getFeatureFlags(),
    imageProvider: "openai",
    animationProvider: "veo",
    musicProviderSetting: "curated-library",
    motion: "ai_animation",
    sceneTexts: segments.map((s) => s.text),
    sceneActions: segments.map((s) => s.visibleAction),
    sceneEnergy: direction.sceneEnergy,
  });
  const bible = buildContinuityBible({ profile: direction.profile, intent: direction.intent.id, topic: TOPIC, scenes: segments });
  // Estimación con el ritmo típico (2,5 palabras/s); el real se mide con la voz antes de pagar imágenes.
  const words = segments.map((s) => s.text.split(/\s+/).filter(Boolean).length);
  const scenes = segments.map((s, i) => {
    const image = buildAnimationBaseImagePrompt({ profile: direction.profile, bible, concept: s.visualConcepts?.[0] ?? s.visualQuery, narration: s.text, action: planSceneAction(s), framing: "fill" });
    const clip = planSceneAnimation({
      sceneIndex: i,
      segment: s,
      energy: direction.sceneEnergy[i] ?? "medium",
      intent: direction.intent.id,
      bible,
      referenceImagePath: `${PREFIX}/scene-${i}-animbase.png`,
      referenceImageKey: "plan",
      visibleSeconds: words[i] / 2.5,
      framing: "fill",
    });
    return {
      scene: i + 1,
      text: s.text,
      words: words[i],
      energy: direction.sceneEnergy[i],
      conservativeSeconds: +estimatedSceneSeconds(s.text).toFixed(2),
      typicalSeconds: +(words[i] / 2.5).toFixed(2),
      action: s.visibleAction,
      imagePrompt: image.prompt,
      clipPrompt: clip.prompt,
    };
  });
  const selection = selectDirectedTracks({ manifest: MUSIC_MANIFEST, direction: direction.music.id as never, seed: PREFIX });
  const candidates = selection.status === "matched" ? selection.candidates.map((t) => t.id) : [];
  const pinned = MUSIC_MANIFEST.find((t) => t.id === PINNED_TRACK);
  const chars = segments.map((s) => s.text).join(" ").length;
  const clip = animationClipCostUsd();
  const budget = {
    images: { count: 4, reserveEachUsd: IMAGE_RESERVE_USD, usd: round(4 * IMAGE_RESERVE_USD) },
    clips: { count: 4, seconds: REEL_ANIMATION.clipSeconds, model: REEL_ANIMATION.model, eachUsd: clip, usd: round(4 * clip) },
    voice: { characters: chars, typicalUsd: round(voiceCostUsd(chars)), reserveEachUsd: round(voiceReserveUsd(chars)), syntheses: 2, usd: round(2 * voiceReserveUsd(chars)) },
    recovery: { images: 1, clips: 1, usd: round(IMAGE_RESERVE_USD + clip) },
  };
  const totalUsd = round(budget.images.usd + budget.clips.usd + budget.voice.usd + budget.recovery.usd);
  return {
    mode,
    direction: { summary: direction.summary, intent: direction.intent.id, music: direction.music.id, sceneEnergy: direction.sceneEnergy },
    totals: { words: words.reduce((a, b) => a + b, 0), typicalSeconds: +(words.reduce((a, b) => a + b, 0) / 2.5 + 0.5).toFixed(1), targetSeconds: TOTAL },
    readiness: { ok: readiness.ok, issues: readiness.issues.map((x) => x.message), animation: readiness.animation },
    bible: { subject: bible.recurringSubject, setting: bible.setting },
    scenes,
    music: {
      direction: direction.music.id,
      candidates: candidates.slice(0, 3),
      pinnedFirst: candidates[0] === PINNED_TRACK,
      pinned: pinned ? { id: pinned.id, title: pinned.title, author: pinned.author, license: pinned.license, sourceUrl: pinned.sourceUrl, obtained: pinned.dateObtainedISO } : null,
    },
    budget: { ...budget, totalUsd, proposedCapUsd: PROPOSED_CAP_USD, typicalUsd: round(4 * 0.0574 + 4 * clip + budget.voice.typicalUsd), perKindCaps: RUN_ENV },
  };
}

/**
 * Voz primero; con los tiempos reales, ajuste de ritmo acotado; luego el
 * pipeline de producto con esa misma voz (acierto de caché, sin pagarla otra vez).
 */
async function produce(input: { service: SupabaseClient; script: GeneratedScript; direction: Direction; ledger: PaidLedger; voice: ResolvedVoice | undefined; attempt: number }): Promise<ProduceResult> {
  const { getVoiceProvider } = await import("../src/lib/providers/voice");
  const { synthesizeNarrationCached } = await import("../src/lib/video/audiovisual/voice-cache");
  const { animatedNarrationFit, fitSpeedAdjustment } = await import("../src/lib/video/audiovisual/narration-fit");
  const { generateDirectedVideoFromScript } = await import("../src/lib/video/audiovisual/directed-reel");
  const segments = input.script.segments;
  const text = segments.map((s) => s.text).join(" ");
  const voiceProvider = getVoiceProvider();
  const narrate = (speed?: number) =>
    synthesizeNarrationCached({ supabase: input.service, bucket: BUCKET, requestId: PREFIX, voiceProvider, text, language: "es", speed, ledger: input.ledger, attempt: input.attempt, voice: input.voice });
  const fitOf = (v: { words: import("../src/lib/providers/types").WordTiming[]; durationSeconds: number }) =>
    animatedNarrationFit({ segments, words: v.words, narrationSeconds: v.durationSeconds, intent: input.direction.intent.id, sceneEnergy: input.direction.sceneEnergy });

  const first = await narrate();
  const firstFit = fitOf(first);
  log("VOICE_FIT", { speed: null, reused: first.reused, narrationSeconds: first.durationSeconds, ...firstFit });
  let speed = fitSpeedAdjustment(firstFit, { minTotalSeconds: TOTAL.minSeconds, targetTotalSeconds: TOTAL.targetSeconds });
  let fit = firstFit;
  if (speed !== null) {
    const second = await narrate(speed);
    const secondFit = fitOf(second);
    log("VOICE_FIT", { speed, reused: second.reused, narrationSeconds: second.durationSeconds, ...secondFit });
    if (secondFit.fits) {
      fit = secondFit;
    } else if (speed < 1 && firstFit.fits) {
      // Desacelerar solo buscaba alargar; la velocidad de ElevenLabs no escala de forma lineal (alarga
      // pausas) y una escena dejó de caber. Se usa la voz natural ya pagada, que sí cabe.
      log("VOICE_FALLBACK", { rejectedSpeed: speed, reason: "la voz desacelerada no cabe en los clips; se usa la velocidad natural" });
      speed = null;
    } else {
      throw new Error(`Con velocidad ×${speed} las escenas siguen sin caber (${JSON.stringify(secondFit)}). Detenido antes de pagar imágenes y clips.`);
    }
  } else if (!fit.fits) {
    throw new Error(`Las escenas no caben (${JSON.stringify(fit)}). Detenido antes de pagar imágenes y clips.`);
  }

  // Captura las líneas de montaje y música del pipeline para la evidencia.
  const captured: string[] = [];
  const original = console.log;
  console.log = (...a: unknown[]) => {
    const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
    if (line.startsWith("[atomivid:direction-montage]") || line.startsWith("[atomivid:music]")) captured.push(line);
    original(...a);
  };
  let videoPath: string;
  try {
    ({ videoPath } = await generateDirectedVideoFromScript({
      supabase: input.service,
      requestId: PREFIX,
      artifactPrefix: `${PREFIX}/run-${input.attempt}`,
      script: input.script,
      style: STYLE,
      topic: TOPIC,
      language: "es",
      direction: input.direction,
      attempt: input.attempt,
      paid: { ledger: input.ledger, recordCosts: false },
      voice: input.voice,
      animationFraming: "fill",
      ...(speed !== null ? { narrationSpeed: speed } : {}),
      onProgress: (stage) => original(`  [medieval-reel] etapa: ${stage}`),
    }));
  } finally {
    console.log = original;
  }
  const json = (prefix: string) => {
    const line = captured.find((l) => l.startsWith(prefix));
    return line ? JSON.parse(line.slice(line.indexOf("{"))) : null;
  };
  const montage = json("[atomivid:direction-montage]");
  const music = json("[atomivid:music]");
  return { videoPath, shots: montage?.shots ?? [], totalSeconds: montage?.totalSeconds ?? 0, speed, trackId: music?.trackId ?? null, fit };
}

async function resolveHansVoice(service: SupabaseClient): Promise<ResolvedVoice> {
  const { checkUserVoice } = await import("../src/lib/voices/resolve");
  const { data, error } = await service.from("user_voices").select("id, user_id, name, status, provider_voice_id, deleted_at").eq("name", VOICE_NAME).is("deleted_at", null);
  if (error) throw new Error(`No se pudo leer la voz «${VOICE_NAME}»: ${error.message}`);
  const rows = (data ?? []) as import("../src/lib/voices/resolve").UserVoiceRow[];
  if (rows.length !== 1) throw new Error(`Se esperaba exactamente una voz «${VOICE_NAME}» vigente; hay ${rows.length}. No se eligió otra.`);
  // Misma comprobación que el producto (propietaria, estado «ready», voice_id presente).
  return checkUserVoice(rows[0], rows[0].user_id);
}

/** La biblioteca queda con UNA pista: si falla su descarga, el pipeline se detiene (antes de gastar) en vez de usar otra. */
async function pinMusicLibrary() {
  const manifest = await import("../src/lib/providers/music/manifest");
  const viaAlias = await import("@/lib/providers/music/manifest");
  if (manifest.MUSIC_MANIFEST !== viaAlias.MUSIC_MANIFEST) throw new Error("La biblioteca musical se cargó dos veces; no se puede fijar la pista.");
  const pinned = manifest.MUSIC_MANIFEST.find((t) => t.id === PINNED_TRACK);
  if (!pinned) throw new Error(`La pista ${PINNED_TRACK} no está en el catálogo.`);
  manifest.MUSIC_MANIFEST.splice(0, manifest.MUSIC_MANIFEST.length, pinned);
}

async function checkPinnedTrack(service: SupabaseClient) {
  const { MUSIC_MANIFEST } = await import("../src/lib/providers/music/manifest");
  const { signMusicLibraryUrl } = await import("../src/lib/providers/music/storage");
  const track = MUSIC_MANIFEST.find((t) => t.id === PINNED_TRACK);
  if (!track) throw new Error(`La pista ${PINNED_TRACK} no está en el catálogo.`);
  const res = await fetch(await signMusicLibraryUrl(service, track.storagePath));
  if (!res.ok) throw new Error(`La pista ${PINNED_TRACK} no se pudo descargar (HTTP ${res.status}).`);
  const bytes = (await res.arrayBuffer()).byteLength;
  return { id: track.id, title: track.title, author: track.author, license: track.license, sourceUrl: track.sourceUrl, bytes };
}

async function downloadBuffer(service: SupabaseClient, objectPath: string): Promise<Buffer> {
  const { data, error } = await service.storage.from(BUCKET).download(objectPath);
  if (error || !data) throw new Error(`No se pudo descargar ${objectPath}: ${error?.message}`);
  return Buffer.from(await data.arrayBuffer());
}

/** Ilustraciones base, imágenes de entrada 9:16 y clips de cada escena (para revisión). */
async function downloadSceneAssets(service: SupabaseClient) {
  const dir = path.join(outDir, "scenes");
  await fs.mkdir(dir, { recursive: true });
  for (const folder of [PREFIX, `${PREFIX}/anim-input`]) {
    const { data } = await service.storage.from(BUCKET).list(folder, { search: "scene-", limit: 100 });
    for (const item of data ?? []) {
      if (!/\.(png|jpe?g|webp|mp4)$/.test(item.name)) continue;
      await fs.writeFile(path.join(dir, `${folder.endsWith("anim-input") ? "input-" : ""}${item.name}`), await downloadBuffer(service, `${folder}/${item.name}`));
    }
  }
}

async function collectEvidence(file: string, result: ProduceResult) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]);
  const probe = JSON.parse(stdout) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string; size: string } };
  const video = probe.streams.find((s) => s.codec_type === "video");
  const duration = Number(probe.format.duration);
  if (video?.width !== 1080 || video.height !== 1920) throw new Error(`Resolución inesperada: ${video?.width}x${video?.height}`);
  if (Math.abs(duration - result.totalSeconds) > 0.25) throw new Error(`Duración ${duration} s distinta de la planificada ${result.totalSeconds} s.`);
  const frames = path.join(outDir, "frames");
  await fs.mkdir(frames, { recursive: true });
  for (const shot of result.shots as { sceneIndex: number; startSeconds: number; endSeconds: number; transitionInFrames: number }[]) {
    const from = shot.startSeconds + shot.transitionInFrames / 30 + 0.1;
    for (const [label, t] of [["inicio", from], ["medio", (from + shot.endSeconds) / 2], ["final", shot.endSeconds - 0.15]] as const) {
      await run("ffmpeg", ["-v", "error", "-y", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", path.join(frames, `escena-${shot.sceneIndex + 1}-${label}.png`)]);
    }
  }
  await run("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", "fps=1/2,scale=216:384,tile=8x2", "-frames:v", "1", path.join(outDir, "contact-sheet.png")]);
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"], { maxBuffer: 1 << 26 });
  const summary = stderr.slice(stderr.lastIndexOf("Summary"));
  const delivery = await deliveryCopy(file, duration);
  const report = {
    width: video.width,
    height: video.height,
    durationSeconds: duration,
    plannedSeconds: result.totalSeconds,
    voiceSpeed: result.speed,
    fit: result.fit,
    trackId: result.trackId,
    shots: result.shots,
    loudness: { integratedLufs: /I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1], truePeakDbfs: /Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1] },
    renderBytes: Number(probe.format.size),
    delivery,
  };
  await fs.writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  return report;
}

/** Copia para el teléfono: H.264 High nivel 4.1, yuv420p, faststart y ≤ 28 MiB (se adjunta directamente). */
async function deliveryCopy(file: string, durationSeconds: number) {
  const out = path.join(outDir, DELIVERY_NAME);
  const audioKbps = 192;
  const videoKbps = Math.min(12000, Math.floor((DELIVERY_MAX_BYTES * 8 * 0.96) / durationSeconds / 1000) - audioKbps);
  const common = ["-v", "error", "-y", "-i", file, "-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-level:v", "4.1", "-pix_fmt", "yuv420p", "-b:v", `${videoKbps}k`, "-maxrate", `${videoKbps * 2}k`, "-bufsize", `${videoKbps * 2}k`];
  const passlog = path.join(outDir, "x264pass");
  await run("ffmpeg", [...common, "-pass", "1", "-passlogfile", passlog, "-an", "-f", "mp4", "/dev/null"], { maxBuffer: 1 << 26 });
  await run("ffmpeg", [...common, "-pass", "2", "-passlogfile", passlog, "-c:a", "aac", "-b:a", `${audioKbps}k`, "-movflags", "+faststart", out], { maxBuffer: 1 << 26 });
  for (const f of await fs.readdir(outDir)) if (f.startsWith("x264pass")) await fs.rm(path.join(outDir, f), { force: true });
  const bytes = (await fs.stat(out)).size;
  if (bytes > DELIVERY_MAX_BYTES) throw new Error(`La copia de entrega ocupa ${bytes} bytes (> 28 MiB).`);
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=profile,level,width,height,pix_fmt", "-of", "json", out]);
  return { file: DELIVERY_NAME, bytes, videoKbps, stream: (JSON.parse(stdout) as { streams: unknown[] }).streams[0] };
}

/**
 * Evidencia del encuadre «fill» con una imagen 2:3 como las del proveedor
 * real (1024×1536): marcas en el 5 % exterior de cada lado (deben quedar
 * fuera) y un sujeto en el 80 % central (debe quedar entero), sin bandas.
 */
async function fillCropEvidence() {
  const sharp = (await import("sharp")).default;
  const { frameAnimationInput } = await import("../src/lib/video/audiovisual/animated-clip");
  const W = 1024;
  const H = 1536;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#3a3f45"/>
    <rect x="0" y="0" width="${Math.round(W * 0.05)}" height="${H}" fill="#00ff00"/>
    <rect x="${W - Math.round(W * 0.05)}" y="0" width="${Math.round(W * 0.05)}" height="${H}" fill="#00ff00"/>
    <rect x="${Math.round(W * 0.1)}" y="${Math.round(H * 0.1)}" width="${Math.round(W * 0.8)}" height="${Math.round(H * 0.6)}" fill="#c00000"/>
  </svg>`;
  const source = await sharp(Buffer.from(svg)).png().toBuffer();
  const results: Record<string, unknown> = {};
  for (const framing of ["fit", "fill"] as const) {
    const { png } = await frameAnimationInput(source, framing);
    await fs.writeFile(path.join(outDir, `encuadre-${framing}.png`), png);
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => {
      const o = (y * info.width + x) * 3;
      return [data[o], data[o + 1], data[o + 2]];
    };
    const isGreen = (p: number[]) => p[1] > 200 && p[0] < 60 && p[2] < 60;
    const isRed = (p: number[]) => p[0] > 170 && p[1] < 50 && p[2] < 50;
    let green = 0;
    for (let y = 0; y < info.height; y += 8) for (let x = 0; x < info.width; x += 4) if (isGreen(px(x, y))) green++;
    const subjectCorners = [
      [0.13, 0.14],
      [0.87, 0.14],
      [0.13, 0.66],
      [0.87, 0.66],
    ].map(([fx, fy]) => isRed(px(Math.round(info.width * fx), Math.round(info.height * fy))));
    results[framing] = { width: info.width, height: info.height, topRow: px(540, 2), greenSamples: green, subjectCornersInside: subjectCorners.every(Boolean) };
  }
  const fill = results.fill as { width: number; height: number; greenSamples: number; subjectCornersInside: boolean; topRow: number[] };
  if (fill.width !== 1080 || fill.height !== 1920) throw new Error("El encuadre «fill» no produce 1080×1920.");
  if (fill.greenSamples !== 0) throw new Error("El encuadre «fill» conserva el borde exterior que debía recortarse.");
  if (!fill.subjectCornersInside) throw new Error("El encuadre «fill» cortó el sujeto del 80 % central.");
  if (Math.abs(fill.topRow[0] - 0x3a) > 6 || Math.abs(fill.topRow[1] - 0x3f) > 6) throw new Error("El encuadre «fill» tiene una banda arriba.");
  return results;
}

/** Supabase simulado sobre disco, con URLs firmadas servidas por HTTP local (solo ensayo). */
async function diskSupabase(): Promise<{ service: SupabaseClient; close: () => void }> {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "atomivid-medieval-reel-"));
  const TYPES: Record<string, string> = { ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".png": "image/png", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4", ".json": "application/json" };
  const server = http.createServer((req, res) => {
    const file = path.join(storageDir, decodeURIComponent(req.url ?? ""));
    if (!file.startsWith(storageDir) || !fsSync.existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader("Content-Type", TYPES[path.extname(file)] ?? "application/octet-stream");
    fsSync.createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const uploaded = new Set<string>();
  const service = {
    storage: {
      from: () => ({
        async upload(p: string, buffer: Buffer) {
          const full = path.join(storageDir, p);
          await fs.mkdir(path.dirname(full), { recursive: true });
          await fs.writeFile(full, buffer);
          uploaded.add(p);
          return { error: null };
        },
        async download(p: string) {
          const full = path.join(storageDir, p);
          if (!fsSync.existsSync(full)) return { data: null, error: { message: "Object not found", statusCode: "404" } };
          return { data: new Blob([new Uint8Array(await fs.readFile(full))]), error: null };
        },
        async remove(paths: string[]) {
          for (const p of paths) await fs.rm(path.join(storageDir, p), { force: true });
          return { data: [], error: null };
        },
        async createSignedUrl(p: string) {
          return { data: { signedUrl: `http://127.0.0.1:${port}/${p}` }, error: null };
        },
        async list(dir: string, opts: { search: string }) {
          return { data: [...uploaded].filter((p) => p.startsWith(`${dir}/`) && p.includes(opts.search)).map((p) => ({ name: p.split("/").pop()! })), error: null };
        },
      }),
    },
    from: () => ({ insert: async () => ({ error: null }), upsert: async () => ({ error: null }) }),
  } as unknown as SupabaseClient;
  return { service, close: () => server.close() };
}

function round(n: number) {
  return Math.round(n * 10000) / 10000;
}

main().catch((err) => {
  console.error("Reel Medieval detenido:", err instanceof Error ? err.message : err);
  process.exit(1);
});
