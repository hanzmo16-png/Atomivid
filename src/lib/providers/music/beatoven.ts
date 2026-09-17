import type { MusicProvider, MusicResult, MusicSelectionContext } from "../types";
import { inferTone } from "./tone";
import { MusicDownloadError, MusicInvalidFileError, MusicProviderError } from "./errors";
import { validateAudioBuffer } from "./validate";
import { getFeatureFlags } from "@/lib/video/feature-flags";

/**
 * Adaptador para Beatoven.ai "Maestro" (música generada, licenciada para
 * uso comercial según su propio anuncio público). IMPORTANTE: este
 * entorno tiene bloqueado el acceso a www.beatoven.ai por política de red
 * (confirmado al intentar leer la documentación oficial vía WebFetch) —
 * no pude confirmar el endpoint exacto, el esquema de request/response ni
 * el precio real contra documentación primaria. Lo que SÍ se confirmó por
 * búsqueda (fuentes secundarias, sep 2026): Maestro existe, se anuncia
 * como "fully licensed" para uso comercial, y se ofrece tanto vía
 * beatoven.ai/api como vía el marketplace de fal.ai. El endpoint/schema de
 * abajo es un ANDAMIAJE PLAUSIBLE (patrón típico compose→poll→download de
 * APIs de música generativa), NO una integración verificada — no actives
 * BEATOVEN_API_KEY en producción hasta confirmar el contrato real de la
 * API y su precio contra la fuente oficial.
 *
 * La música curada (Pixabay/Mixkit vía manifest.ts) sigue siendo el
 * fallback SIEMPRE disponible — un fallo aquí nunca debe bloquear el
 * render completo (ver el try/catch alrededor de musicProvider.getTrack
 * en generate-video.ts, que ya trata cualquier MusicProvider igual).
 */

const BEATOVEN_API_BASE = process.env.BEATOVEN_API_BASE || "https://public-api.beatoven.ai";
const POLL_TIMEOUT_MS = Number(process.env.BEATOVEN_POLL_TIMEOUT_MS || "120000");
const POLL_DELAY_MS = 3000;
const MAX_POLL_ATTEMPTS = Number(process.env.BEATOVEN_MAX_POLL_ATTEMPTS || "30");
// UNVERIFICADO — sin precio público confirmado; 0 por defecto para que
// nunca se autorice gasto real sin que alguien configure explícitamente
// un valor real conocido.
const ESTIMATED_COST_USD = Number(process.env.BEATOVEN_ESTIMATED_COST_USD || "0");

function getApiKey(): string {
  const key = process.env.BEATOVEN_API_KEY?.trim();
  if (!key) throw new MusicProviderError('BEATOVEN_API_KEY no está configurada (proveedor "beatoven").');
  return key;
}

/**
 * Traduce el contexto de selección (mismo que usa el proveedor curado) a
 * un prompt descriptivo en el estilo pedido por el producto — género,
 * ánimo, energía, instrumentación, arco emocional, exclusiones — en vez
 * de mandar solo un par de palabras sueltas.
 */
export function buildMusicPrompt(context: MusicSelectionContext): string {
  const tones = inferTone({ style: context.style, topic: context.topic, scriptText: context.scriptText });
  const primary = tones[0] ?? "cinematic";

  const moodByTone: Partial<Record<string, string>> = {
    motivational: "restrained and introspective opening, gradual emotional rise, confident but not corporate",
    cinematic: "sweeping but intimate, cinematic underscore, restrained until the emotional peak",
    inspirational: "warm and hopeful, gentle build, uplifting without triumphant cliché",
    tension: "sparse and suspenseful, subtle unease, controlled release of tension",
    reflective: "sparse, introspective, unhurried, space to breathe",
    energetic: "driving pulse from the start, modern and propulsive",
    minimal: "minimal instrumentation, subtle textures, unobtrusive",
    corporate: "clean and confident, modern, unobtrusive under narration",
    technology: "modern, precise, subtle electronic pulse",
    luxury: "elegant, restrained, refined instrumentation",
  };

  const descriptor = moodByTone[primary] ?? "restrained, modern, emotionally coherent with the message";

  return (
    `Cinematic ${primary} underscore, ${descriptor}, modern organic percussion, warm strings and subtle pulse, ` +
    "no vocals, designed beneath spoken narration, clean ending. " +
    `Target duration: ${Math.round(context.durationSeconds)} seconds.`
  );
}

type BeatovenComposeResponse = { task_id?: string };
type BeatovenStatusResponse = { status?: "composing" | "completed" | "failed"; meta?: { track_url?: string } };

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function composeTrack(prompt: string, durationSeconds: number): Promise<string> {
  const response = await fetch(`${BEATOVEN_API_BASE}/api/v1/tracks/compose`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: { text: prompt },
      format: "mp3",
      duration_seconds: Math.round(durationSeconds),
    }),
  });
  if (!response.ok) {
    throw new MusicProviderError(`Beatoven respondió HTTP ${response.status} al pedir composición`);
  }
  const json = (await response.json()) as BeatovenComposeResponse;
  if (!json.task_id) {
    throw new MusicProviderError("Beatoven no devolvió un task_id de composición");
  }
  return json.task_id;
}

async function waitForTrack(taskId: string): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    if (Date.now() > deadline) {
      throw new MusicProviderError(`Tiempo de espera agotado sondeando la composición de Beatoven (${POLL_TIMEOUT_MS}ms)`);
    }
    const response = await fetch(`${BEATOVEN_API_BASE}/api/v1/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${getApiKey()}` },
    });
    if (!response.ok) {
      throw new MusicProviderError(`Beatoven respondió HTTP ${response.status} al consultar la tarea`);
    }
    // Nunca se loguea taskId junto con la URL de la pista resultante.
    const json = (await response.json()) as BeatovenStatusResponse;
    if (json.status === "completed" && json.meta?.track_url) return json.meta.track_url;
    if (json.status === "failed") {
      throw new MusicProviderError("La composición de Beatoven falló del lado del proveedor");
    }
    await sleep(POLL_DELAY_MS);
  }
  throw new MusicProviderError("Se agotaron los intentos de sondeo de la composición de Beatoven");
}

export const beatovenMusicProvider: MusicProvider = {
  name: "beatoven",
  async getTrack(context: MusicSelectionContext): Promise<MusicResult> {
    const maxMusicCostUsd = getFeatureFlags().maxMusicCostUsd;
    if (ESTIMATED_COST_USD > maxMusicCostUsd) {
      throw new MusicProviderError(
        `Costo estimado de Beatoven ($${ESTIMATED_COST_USD}) excede el máximo configurado (MAX_MUSIC_COST_USD=$${maxMusicCostUsd})`,
      );
    }

    const prompt = buildMusicPrompt(context);
    const taskId = await composeTrack(prompt, context.durationSeconds);
    const trackUrl = await waitForTrack(taskId);

    let res: Response;
    try {
      res = await fetch(trackUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : "error de red desconocido";
      throw new MusicDownloadError(`No se pudo descargar la pista de Beatoven: ${message}`);
    }
    if (!res.ok) {
      throw new MusicDownloadError(`No se pudo descargar la pista de Beatoven: HTTP ${res.status}`);
    }

    const audioBuffer = Buffer.from(await res.arrayBuffer());
    const validation = validateAudioBuffer(audioBuffer);
    if (!validation.valid) {
      throw new MusicInvalidFileError(`Archivo de Beatoven inválido: ${validation.reason}`);
    }

    return {
      audioBuffer,
      durationSeconds: context.durationSeconds,
      mimeType: "audio/mpeg",
      extension: validation.format,
      track: {
        provider: "beatoven",
        trackId: taskId,
        title: "Composición generada (Beatoven Maestro)",
        author: "Beatoven.ai Maestro",
        sourceUrl: "https://www.beatoven.ai/",
        license: "Beatoven.ai — anunciado como apto para uso comercial (no verificado contra ToS primarios en este entorno)",
        tones: inferTone({ style: context.style, topic: context.topic, scriptText: context.scriptText }),
      },
    };
  },
};
