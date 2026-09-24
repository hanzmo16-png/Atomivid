import { MissingEnvVarError } from "@/lib/env-errors";
import { GenerativeProviderError, type GenerativeAsset, type VideoGenerationRequest, type VideoProvider } from "../types";

/**
 * Adaptador para la API de Runway (clips premium, gancho/cierre). Igual
 * que openai.ts: este entorno tiene bloqueado el acceso a
 * docs.dev.runwayml.com por política de red (confirmado al intentar leer
 * la documentación oficial vía WebFetch) — modelo, endpoint, precio y
 * duraciones de abajo vienen de fuentes SECUNDARIAS (sep 2026), NO
 * verificados contra la documentación primaria de Runway. Configurables
 * por variable de entorno por la misma razón que en openai.ts — confirma
 * contra https://docs.dev.runwayml.com/ antes de activar con una clave real.
 *
 * La API de Runway es asíncrona por tareas (crear tarea → sondear estado
 * → descargar resultado) — se implementa con sondeo y backoff exponencial
 * acotado (nunca sondeo infinito), y NUNCA se imprime la URL firmada del
 * resultado ni el token de la tarea en logs (solo su estado normalizado).
 */

// UNVERIFICADO contra doc oficial — fuente secundaria.
const RUNWAY_API_BASE = process.env.RUNWAY_API_BASE || "https://api.dev.runwayml.com/v1";
const DEFAULT_MODEL = process.env.RUNWAY_MODEL || "gen4_turbo";
// UNVERIFICADO — fuente secundaria reporta $0.05/seg para Gen-4 Turbo.
const COST_USD_PER_SECOND = Number(process.env.RUNWAY_COST_USD_PER_SECOND || "0.05");
// Runway solo documenta (fuente secundaria) duraciones de 5 o 10 segundos.
const ALLOWED_DURATIONS = [5, 10];
const POLL_TIMEOUT_MS = Number(process.env.RUNWAY_POLL_TIMEOUT_MS || "180000");
const POLL_INITIAL_DELAY_MS = 2000;
const POLL_MAX_DELAY_MS = 15000;
const MAX_POLL_ATTEMPTS = Number(process.env.RUNWAY_MAX_POLL_ATTEMPTS || "20");

function getApiKey(): string {
  const key = process.env.RUNWAY_API_KEY?.trim();
  if (!key) throw new MissingEnvVarError("RUNWAY_API_KEY");
  return key;
}

function nearestAllowedDuration(requested: number): number {
  return ALLOWED_DURATIONS.reduce((best, d) => (Math.abs(d - requested) < Math.abs(best - requested) ? d : best));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type RunwayTaskStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "THROTTLED";

// UNVERIFICADO contra doc oficial — placeholders 9:16/16:9, confirmar los
// valores exactos aceptados por la API real antes de usar con una clave.
const RATIO_BY_ASPECT: Record<VideoGenerationRequest["aspectRatio"], string> = {
  "9:16": "768:1280",
  "16:9": "1280:768",
};

async function createTask(request: VideoGenerationRequest, durationSeconds: number): Promise<string> {
  const response = await fetch(`${RUNWAY_API_BASE}/text_to_video`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      promptText: request.negativePrompt
        ? `${request.prompt}\n\nAvoid: ${request.negativePrompt}`
        : request.prompt,
      ratio: RATIO_BY_ASPECT[request.aspectRatio],
      duration: durationSeconds,
    }),
  });

  if (!response.ok) {
    throw new GenerativeProviderError(`Runway respondió HTTP ${response.status} al crear la tarea`, "runway", "upstream_error");
  }
  const json = (await response.json()) as { id?: string };
  if (!json.id) {
    throw new GenerativeProviderError("Runway no devolvió un id de tarea", "runway", "invalid_response");
  }
  return json.id;
}

async function pollTask(taskId: string): Promise<{ status: RunwayTaskStatus; outputUrl?: string; failureReason?: string }> {
  const response = await fetch(`${RUNWAY_API_BASE}/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${getApiKey()}` },
  });
  if (!response.ok) {
    throw new GenerativeProviderError(`Runway respondió HTTP ${response.status} al consultar la tarea`, "runway", "upstream_error");
  }
  const json = (await response.json()) as {
    status?: RunwayTaskStatus;
    output?: string[];
    failure?: string;
  };
  return {
    status: json.status ?? "FAILED",
    outputUrl: json.output?.[0],
    failureReason: json.failure,
  };
}

async function waitForCompletion(taskId: string): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let delay = POLL_INITIAL_DELAY_MS;

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    if (Date.now() > deadline) {
      throw new GenerativeProviderError(
        `Tiempo de espera agotado sondeando la tarea de Runway (${POLL_TIMEOUT_MS}ms)`,
        "runway",
        "timeout",
      );
    }
    // Nunca se loguea taskId completo con su URL firmada de resultado — solo el estado, aquí y en cualquier console.log del llamador.
    const { status, outputUrl, failureReason } = await pollTask(taskId);
    if (status === "SUCCEEDED" && outputUrl) return outputUrl;
    if (status === "FAILED") {
      const isModeration = (failureReason ?? "").toLowerCase().includes("moderat");
      throw new GenerativeProviderError(
        `Tarea de Runway falló${failureReason ? `: ${failureReason}` : ""}`,
        "runway",
        isModeration ? "moderation_rejected" : "upstream_error",
      );
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, POLL_MAX_DELAY_MS);
  }

  throw new GenerativeProviderError("Se agotaron los intentos de sondeo de la tarea de Runway", "runway", "timeout");
}

export const runwayVideoProvider: VideoProvider = {
  name: "runway",
  capabilities: {
    id: "runway",
    models: [DEFAULT_MODEL],
    formats: ["video/mp4"],
    aspectRatios: ["9:16", "16:9"],
    timeoutMs: POLL_TIMEOUT_MS,
    maxRetries: 0, // Una tarea de Runway ya cuesta dinero al crearse — nunca se reintenta automáticamente, ver runway.isAvailable()/generateVideo.
  },
  isAvailable() {
    return Boolean(process.env.RUNWAY_API_KEY?.trim());
  },
  async generateVideo(request: VideoGenerationRequest): Promise<GenerativeAsset> {
    if (!this.isAvailable()) {
      throw new GenerativeProviderError("RUNWAY_API_KEY no está configurada", "runway", "not_configured");
    }

    const durationSeconds = nearestAllowedDuration(request.durationSeconds);
    const estimatedCost = durationSeconds * COST_USD_PER_SECOND;
    if (estimatedCost > request.maxCostUsd) {
      throw new GenerativeProviderError(
        `Costo estimado ($${estimatedCost}) excede el máximo permitido para este clip ($${request.maxCostUsd})`,
        "runway",
        "budget_exceeded",
      );
    }

    const taskId = await createTask(request, durationSeconds);
    const outputUrl = await waitForCompletion(taskId);

    const videoRes = await fetch(outputUrl);
    if (!videoRes.ok) {
      throw new GenerativeProviderError(`No se pudo descargar el clip de Runway (HTTP ${videoRes.status})`, "runway", "upstream_error");
    }
    const buffer = Buffer.from(await videoRes.arrayBuffer());
    if (buffer.byteLength === 0) {
      throw new GenerativeProviderError("Clip de Runway descargado con tamaño 0 bytes", "runway", "invalid_response");
    }

    return {
      buffer,
      mimeType: "video/mp4",
      extension: "mp4",
      durationSeconds,
      model: DEFAULT_MODEL,
      costUsd: estimatedCost,
      providerJobId: taskId,
    };
  },
};
