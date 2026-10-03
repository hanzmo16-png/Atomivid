/**
 * Luma adapter for VFX / Transform Scene — Ray 3.2 `video_edit` on the Luma Agents API.
 *
 * Contract verified (2026-10-02) against Luma's official SDK `luma-agents` 0.5.0 (PyPI, published by
 * Luma <support+luma-agents@lumalabs.ai>, 2026-08-05, generated from Luma's API spec):
 *   - base https://agents.lumalabs.ai/v1, `Authorization: Bearer <key>`;
 *   - Files API: POST /files (JSON → presigned `upload` {url, method PUT, headers}), PUT the bytes,
 *     POST /files/{id}/complete, GET /files/{id} until state `ready` (pending | ready | failed | deleted);
 *     GET /files?limit=n lists files (read-only);
 *   - POST /generations { type: "video_edit", model: "ray-3.2", prompt,
 *     source: { file_id }, video: { resolution: 360p|540p|720p|1080p, hdr, edit: { strength:
 *     adhere_1..3 | flex_1..3 | reimagine_1..3, auto_controls, controls: { face {enabled}, pose
 *     {enabled, strength precise|coarse}, depth {enabled, blur 0..1}, normals {enabled, augmentation
 *     0..1}, trajectory {enabled, sparsity 0..1} } } };
 *   - the video_edit source must be ≤ 18 s and the output lasts as long as the source;
 *   - GET /generations/{id} → state queued | processing | completed | failed, output[].url (presigned, 1 h),
 *     failure_code.
 * No `aspect_ratio` is sent for video_edit: the SDK says valid values depend on the generation type
 * and the edit inherits the source's geometry (VFX-001 attempt 1 was refused with HTTP 422 while
 * sending it; the request is otherwise identical). The source must already be in the target aspect.
 * There is no seed and no negative-prompt field: a seed is refused, the negative prompt is written into
 * the prompt text. The SDK documents the strength bands, not a numeric scale; the enum order is read as
 * going from most preserving (adhere_1) to most reimagined (reimagine_3).
 *
 * The previous Dream Machine v1 `modify_video` (ray-2 / ray-flash-2) adapter was removed: this is
 * the only Luma VFX contract.
 */
import { createHash } from "node:crypto";
import { fetchFailureOutcome, httpStatusOutcome } from "../charge-outcome";
import { GenerativeProviderError } from "../types";
import { estimateVfxCostUsd } from "./pricing";
import type { VfxAsset, VfxEditControls, VfxProvider, VfxStrength, VfxTransformRequest } from "./types";

export const LUMA_API_BASE = "https://agents.lumalabs.ai/v1";
export const LUMA_VFX_MODEL = "ray-3.2";
export const LUMA_VFX_REQUEST_TYPE = "video_edit";
export const LUMA_SDK_SOURCE = "luma-agents 0.5.0 (PyPI, 2026-08-05)";
export const LUMA_MAX_SOURCE_SECONDS = 18;
export const LUMA_EDIT_STRENGTHS = ["adhere_1", "adhere_2", "adhere_3", "flex_1", "flex_2", "flex_3", "reimagine_1", "reimagine_2", "reimagine_3"] as const;
export type LumaEditStrength = (typeof LUMA_EDIT_STRENGTHS)[number];

/** Product strength → Ray 3.2 edit strength. Conservative: preserving the subject never reaches the reimagine band. */
export function lumaStrengthFor(r: Pick<VfxTransformRequest, "strength" | "preserveSubject">): LumaEditStrength {
  const map: Record<VfxStrength, LumaEditStrength> = { subtle: "adhere_2", balanced: "flex_1", strong: r.preserveSubject ? "flex_3" : "reimagine_1" };
  return map[r.strength];
}

type LumaControls = {
  face?: { enabled: boolean };
  pose?: { enabled: boolean; strength?: "precise" | "coarse" };
  depth?: { enabled: boolean; blur?: number };
  normals?: { enabled: boolean; augmentation?: number };
  trajectory?: { enabled: boolean; sparsity?: number };
};

const fail = (message: string, reason: GenerativeProviderError["reason"], jobId?: string, outcome: "not_sent" | "rejected" | "uncertain" = jobId ? "uncertain" : "not_sent") =>
  new GenerativeProviderError(message, "luma", reason, undefined, jobId, outcome);

const unit = (v: number | undefined, name: string) => {
  if (v === undefined) return undefined;
  if (!(Number.isFinite(v) && v >= 0 && v <= 1)) throw fail(`Luma: ${name} debe estar entre 0 y 1`, "invalid_request");
  return v;
};

/** Pure: provider-agnostic controls → documented Ray 3.2 `video.edit.controls`. */
export function lumaControlsFor(c: VfxEditControls | undefined): LumaControls | undefined {
  if (!c) return undefined;
  const out: LumaControls = {};
  if (c.faceIdentity !== undefined) out.face = { enabled: c.faceIdentity };
  if (c.pose !== undefined) out.pose = c.pose === "off" ? { enabled: false } : { enabled: true, strength: c.pose };
  if (c.depth) out.depth = { enabled: c.depth.enabled, ...(c.depth.freedom === undefined ? {} : { blur: unit(c.depth.freedom, "depth.freedom") }) };
  if (c.normals) out.normals = { enabled: c.normals.enabled, ...(c.normals.freedom === undefined ? {} : { augmentation: unit(c.normals.freedom, "normals.freedom") }) };
  if (c.trajectory) out.trajectory = { enabled: c.trajectory.enabled, ...(c.trajectory.sparsity === undefined ? {} : { sparsity: unit(c.trajectory.sparsity, "trajectory.sparsity") }) };
  return Object.keys(out).length ? out : undefined;
}

function validate(r: VfxTransformRequest) {
  if (r.seed !== undefined) throw fail("Luma Ray 3.2: video_edit no admite semilla", "invalid_request");
  if (r.dynamicRange !== "sdr") throw fail("Luma: VFX V1 solo admite SDR", "invalid_request");
  if (!(r.source.durationSeconds > 0 && r.source.durationSeconds <= LUMA_MAX_SOURCE_SECONDS)) throw fail(`Luma: el origen de video_edit debe durar como máximo ${LUMA_MAX_SOURCE_SECONDS} s`, "invalid_request");
  if (!/^[0-9a-f]{64}$/.test(r.source.sha256)) throw fail("Luma: sha256 de origen inválido", "invalid_request");
  if (!r.prompt.trim()) throw fail("Luma: prompt vacío", "invalid_request");
}

/** Pure: the exact POST /generations body. No credentials, no network. */
export function buildLumaVideoEditPayload(r: VfxTransformRequest, fileId: string) {
  validate(r);
  if (!fileId) throw fail("Luma: falta file_id del origen (preparar el origen primero)", "invalid_request");
  const parts = [r.prompt.trim()];
  if (r.style?.trim()) parts.push(`Style: ${r.style.trim()}.`);
  if (r.negativePrompt?.trim()) parts.push(`Avoid: ${r.negativePrompt.trim()}`);
  const controls = lumaControlsFor(r.controls);
  return {
    type: LUMA_VFX_REQUEST_TYPE,
    model: LUMA_VFX_MODEL,
    prompt: parts.join("\n\n"),
    source: { file_id: fileId },
    video: {
      resolution: r.resolution,
      hdr: false,
      edit: { strength: lumaStrengthFor(r), ...(controls ? { auto_controls: false, controls } : {}) },
    },
  };
}

function httpReason(status: number): GenerativeProviderError["reason"] {
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 402) return "quota_exceeded";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 404 || status === 413 || status === 415 || status === 422) return "invalid_request";
  return "upstream_error";
}

const FAILURE_REASON: Record<string, GenerativeProviderError["reason"]> = {
  content_moderated: "moderation_rejected",
  budget_exhausted: "quota_exceeded",
  rate_limited: "rate_limited",
  invalid_request: "invalid_request",
  corrupt_input: "invalid_request",
  unsupported_format: "invalid_request",
  image_too_large: "invalid_request",
  output_not_found: "download_failed",
  generation_failed: "upstream_error",
};

/** Provider validation detail for diagnosis: message fields only, URLs removed, length capped (never logs secrets or signed URLs). */
export async function lumaErrorDetail(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const pick = (v: unknown): string => (typeof v === "string" ? v : v && typeof v === "object" ? JSON.stringify(v) : "");
  const raw = body ? pick(body.detail) || pick((body.error as Record<string, unknown> | undefined)?.message) || pick(body.message) || pick(body.error) : "";
  return raw.replace(/https?:\/\/\S+/g, "[url]").replace(/\s+/g, " ").slice(0, 400);
}

export type LumaDeps = { fetch: typeof fetch; sleep: (ms: number) => Promise<void>; now: () => number };
const defaultDeps = (): LumaDeps => ({ fetch: (...a) => fetch(...a), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() });
const apiKey = () => process.env.LUMA_API_KEY?.trim();
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export function createLumaVfxProvider(deps: LumaDeps = defaultDeps(), opts: { pollMs?: number; fileTimeoutMs?: number; generationTimeoutMs?: number } = {}): VfxProvider {
  const pollMs = opts.pollMs ?? 5_000;
  const headers = (json = true) => {
    const key = apiKey();
    if (!key) throw fail("Luma: falta LUMA_API_KEY", "not_configured");
    return { Authorization: `Bearer ${key}`, Accept: "application/json", ...(json ? { "Content-Type": "application/json" } : {}) };
  };
  /** Free Agents API call (files only: no generation). Errors are never billable. */
  const filesCall = async (path: string, init: RequestInit = {}) => {
    let res: Response;
    try {
      res = await deps.fetch(`${LUMA_API_BASE}${path}`, { ...init, redirect: "error", headers: headers(init.method === "POST"), signal: AbortSignal.timeout(30_000) });
    } catch (cause) {
      throw new GenerativeProviderError("Luma Files: fallo de conexión", "luma", "upstream_error", cause, undefined, "not_sent");
    }
    if (!res.ok) {
      const detail = await lumaErrorDetail(res);
      throw fail(`Luma Files: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`, httpReason(res.status), undefined, "not_sent");
    }
    return (await res.json().catch(() => null)) as Record<string, unknown> | null;
  };

  async function waitFileReady(fileId: string): Promise<void> {
    const deadline = deps.now() + (opts.fileTimeoutMs ?? 300_000);
    for (;;) {
      const f = await filesCall(`/files/${encodeURIComponent(fileId)}`);
      if (f?.state === "ready") return;
      if (f?.state === "failed" || f?.state === "deleted") throw fail(`Luma Files: el origen terminó en estado ${String(f.state)}`, "invalid_request");
      if (deps.now() > deadline) throw fail("Luma Files: el origen no quedó listo a tiempo", "timeout");
      await deps.sleep(pollMs);
    }
  }

  async function finish(jobId: string, r: VfxTransformRequest, costUsd: number): Promise<VfxAsset> {
    if (!ID.test(jobId)) throw fail("Luma: id de generación inválido", "invalid_request", jobId);
    const deadline = deps.now() + (opts.generationTimeoutMs ?? 900_000);
    try {
      for (;;) {
        const res = await deps.fetch(`${LUMA_API_BASE}/generations/${encodeURIComponent(jobId)}`, { headers: headers(false), redirect: "error", signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw fail(`Luma: consulta respondió HTTP ${res.status}`, httpReason(res.status), jobId);
        const g = (await res.json().catch(() => null)) as { state?: string; output?: { type?: string; url?: string }[]; failure_code?: string } | null;
        if (g?.state === "completed") {
          const url = (g.output ?? []).find((o) => o.type === "video")?.url ?? g.output?.[0]?.url;
          if (typeof url !== "string" || !url.startsWith("https://")) throw fail("Luma: generación completada sin URL de video", "invalid_response", jobId);
          // Never forward the API key to the media host, never log the presigned URL.
          const video = await deps.fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
          if (!video.ok) throw fail("Luma: falló la descarga del video", "download_failed", jobId);
          const buffer = Buffer.from(await video.arrayBuffer());
          if (!buffer.length) throw fail("Luma: video vacío", "download_failed", jobId);
          return { kind: "vfx_transform", buffer, mimeType: "video/mp4", extension: "mp4", model: LUMA_VFX_MODEL, costUsd, costBasis: "estimated", providerJobId: jobId, durationSeconds: r.source.durationSeconds };
        }
        if (g?.state === "failed") throw fail(`Luma: la generación falló (${g.failure_code ?? "sin código"})`, FAILURE_REASON[g.failure_code ?? ""] ?? "upstream_error", jobId);
        if (g?.state !== "queued" && g?.state !== "processing") throw fail("Luma: estado de generación desconocido", "invalid_response", jobId);
        if (deps.now() > deadline) throw fail("Luma: espera agotada; reanudar la misma generación", "timeout", jobId);
        await deps.sleep(pollMs);
      }
    } catch (cause) {
      if (cause instanceof GenerativeProviderError) throw cause;
      throw new GenerativeProviderError("Luma: consulta o descarga interrumpida; conservar la generación", "luma", "upstream_error", cause, jobId, "uncertain");
    }
  }

  const estimate = (r: VfxTransformRequest) =>
    estimateVfxCostUsd({ provider: "luma", model: LUMA_VFX_MODEL, requestType: LUMA_VFX_REQUEST_TYPE, resolution: r.resolution, dynamicRange: r.dynamicRange, durationSeconds: r.source.durationSeconds });

  return {
    name: "luma",
    capabilities: {
      id: "luma",
      models: [LUMA_VFX_MODEL],
      formats: ["video/mp4"],
      aspectRatios: ["9:16", "16:9", "1:1"],
      timeoutMs: opts.generationTimeoutMs ?? 900_000,
      maxRetries: 0,
      requestType: LUMA_VFX_REQUEST_TYPE,
      contractVerified: true,
      resolutions: ["360p", "540p", "720p", "1080p"],
      maxSourceSeconds: LUMA_MAX_SOURCE_SECONDS,
    },
    isAvailable: () => Boolean(apiKey()),
    resolveModel: () => LUMA_VFX_MODEL,
    describeRequest: (r) => {
      validate(r);
      // Exactly what is sent (aspect_ratio is not sent for video_edit): a changed payload is a new identity.
      return { requestType: LUMA_VFX_REQUEST_TYPE, strength: lumaStrengthFor(r), controls: lumaControlsFor(r.controls) ?? null, autoControls: r.controls ? false : null, hdr: false, resolution: r.resolution, aspectRatioSent: null };
    },
    estimateCostUsd: estimate,

    /** Upload the exact source bytes once (Files API, presigned PUT) and wait until `ready`. Free: no generation. */
    async prepareSource(r) {
      validate(r);
      if (r.source.providerFileId) {
        const f = await filesCall(`/files/${encodeURIComponent(r.source.providerFileId)}`).catch(() => null);
        if (f?.state === "ready" && Number(f.size_bytes) === r.source.sizeBytes) return r;
      }
      let bytes: Buffer;
      try {
        const res = await deps.fetch(r.source.url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        bytes = Buffer.from(await res.arrayBuffer());
      } catch (cause) {
        throw new GenerativeProviderError("Luma: no se pudo leer el video de origen", "luma", "invalid_request", cause, undefined, "not_sent");
      }
      if (bytes.byteLength !== r.source.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== r.source.sha256) {
        throw fail("Luma: el video de origen no coincide con su sha256/tamaño (identidad económica)", "invalid_request");
      }
      const created = await filesCall("/files", {
        method: "POST",
        body: JSON.stringify({ mime_type: r.source.mimeType, size_bytes: r.source.sizeBytes, filename: `atomivid-vfx-${r.source.sha256.slice(0, 16)}.mp4`, purpose: "input" }),
      });
      const fileId = typeof created?.id === "string" ? created.id : undefined;
      const upload = created?.upload as { url?: unknown; method?: unknown; headers?: Record<string, string> } | null | undefined;
      if (!fileId || !ID.test(fileId) || typeof upload?.url !== "string" || !upload.url.startsWith("https://")) throw fail("Luma Files: respuesta sin file id o URL de subida", "invalid_response");
      let put: Response;
      try {
        // Presigned storage URL: only the headers Luma returned, never the API key.
        put = await deps.fetch(upload.url, { method: "PUT", headers: upload.headers ?? {}, body: new Uint8Array(bytes), redirect: "error", signal: AbortSignal.timeout(300_000) });
      } catch (cause) {
        throw new GenerativeProviderError("Luma Files: fallo al subir el origen", "luma", "upstream_error", cause, undefined, "not_sent");
      }
      if (!put.ok) throw fail(`Luma Files: la subida respondió HTTP ${put.status}`, "upstream_error");
      await filesCall(`/files/${encodeURIComponent(fileId)}/complete`, { method: "POST" });
      await waitFileReady(fileId);
      return { ...r, source: { ...r.source, providerFileId: fileId } };
    },

    async transformVideo(r) {
      const costUsd = estimate(r);
      if (costUsd > r.maxCostUsd + 1e-9) throw fail("Luma: presupuesto insuficiente para la edición", "budget_exceeded");
      const body = JSON.stringify(buildLumaVideoEditPayload(r, r.source.providerFileId ?? ""));
      const h = headers();
      let res: Response;
      try {
        res = await deps.fetch(`${LUMA_API_BASE}/generations`, { method: "POST", headers: h, body, redirect: "error", signal: AbortSignal.timeout(60_000) });
      } catch (cause) {
        throw new GenerativeProviderError("Luma: fallo de conexión al enviar; no reenviar sin conciliación", "luma", "upstream_error", cause, undefined, fetchFailureOutcome(cause));
      }
      if (!res.ok) {
        const detail = await lumaErrorDetail(res);
        throw new GenerativeProviderError(`Luma: envío rechazado con HTTP ${res.status}${detail ? ` — ${detail}` : ""}`, "luma", httpReason(res.status), undefined, undefined, httpStatusOutcome(res.status));
      }
      const g = (await res.json().catch(() => null)) as { id?: unknown } | null;
      if (typeof g?.id !== "string" || !ID.test(g.id)) throw new GenerativeProviderError("Luma: respuesta de envío sin id válido; resultado incierto", "luma", "invalid_response", undefined, undefined, "uncertain");
      const jobId = g.id;
      // The generation exists (billable). A callback failure must never cause another POST.
      try {
        await r.onProviderJobAccepted?.(jobId);
      } catch {
        /* keep polling; the job id travels with the result and any error */
      }
      return finish(jobId, r, costUsd);
    },

    async resumeTransform(jobId, r) {
      return finish(jobId, r, estimate(r));
    },
  };
}

export const lumaVfxProvider: VfxProvider = createLumaVfxProvider();

/**
 * Free read-only preflight: GET /files?limit=1 on the Agents API. Authenticates the key and checks
 * access without creating anything (the SDK exposes no balance endpoint). Not used by the pipeline.
 */
export async function lumaFilesPreflight(fetchImpl: typeof fetch = fetch): Promise<{ authenticated: boolean; status: number; filesListed?: number }> {
  const key = apiKey();
  if (!key) throw fail("Luma: falta LUMA_API_KEY", "not_configured");
  const res = await fetchImpl(`${LUMA_API_BASE}/files?limit=1`, { method: "GET", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (res.status === 401 || res.status === 403) return { authenticated: false, status: res.status };
  if (!res.ok) throw fail(`Luma: preflight respondió HTTP ${res.status}`, "upstream_error");
  const body = (await res.json().catch(() => null)) as { data?: unknown[] } | null;
  return { authenticated: true, status: res.status, filesListed: Array.isArray(body?.data) ? body.data.length : undefined };
}
