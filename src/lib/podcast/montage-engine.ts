/**
 * Podcast montage engine (worker step "Montando video"). Two engines, chosen explicitly:
 *  - legacy (default): buildPodcastMontage + readySignal, unchanged;
 *  - director: the podcast Director V1.3.1 through its existing worker adapter (adaptador/worker-adapter.ts,
 *    materializeForWorker), run as a child process inside its OS isolation (scripts/ejecutar_aislado.sh, bubblewrap)
 *    under a dedicated UID. It writes montaje.json + LISTO.json into the same entrada/ folder; the editor step after it
 *    is the worker's own.
 * The director engine is never enabled by default: PODCAST_MONTAGE_ENGINE=director plus PODCAST_DIRECTOR_DIR (the built
 * Director package) plus every isolation barrier. montageGate() runs at the start of a production, before the
 * narration and the stock search: the configuration, the inputs already known to be missing (rights for stock) and a
 * functional launch of the isolation itself. Checks on media that do not exist yet (sample rate, dimensions) can only
 * run later. There is no silent fallback to the other engine.
 * Inputs the worker does not produce today (rights per asset, aligned avatar) are not invented here: rights come only
 * from an explicit server-side RightsPolicy (none exists yet), never from pageUrl/credit or from the browser.
 */
import path from "node:path";

export type MontageEngine = "legacy" | "director";
export type EngineErrorCode =
  | "MONTAGE_ENGINE_UNKNOWN"
  | "DIRECTOR_ENV_MISSING"
  | "DIRECTOR_MODULE_MISSING"
  | "DIRECTOR_ISOLATION_MISSING"
  | "DIRECTOR_UID_NOT_DEDICATED"
  | "DIRECTOR_TEST_HOOKS_SET"
  | "DIRECTOR_PROC_MISSING"
  | "DIRECTOR_RIGHTS_UNAVAILABLE"
  | "DIRECTOR_ISOLATION_PROBE_FAILED"
  | "DIRECTOR_AUDIO_SAMPLE_RATE"
  | "DIRECTOR_OUTPUT_INVALID"
  | "DIRECTOR_EXIT";
export type EngineError = { code: EngineErrorCode | string; message: string };
export type DirectorRuntime = { dir: string; adapter: string; isolate: string; runner: string };
export type EngineChoice =
  | { ok: true; engine: "legacy" }
  | { ok: true; engine: "director"; runtime: DirectorRuntime }
  | { ok: false; engine: string; errors: EngineError[] };

export type EngineDeps = {
  env: Record<string, string | undefined>;
  uid: number | null;
  exists: (p: string) => boolean;
  onPath: (cmd: string) => boolean;
  /** Absolute path of scripts/podcast-director-step.cjs in this checkout. */
  runner: string;
};

/** Files of the built Director package the engine needs (relative to PODCAST_DIRECTOR_DIR). */
export const DIRECTOR_FILES = { adapter: "dist/adaptador/worker-adapter.js", materialize: "dist/src/materialize.js", isolate: "scripts/ejecutar_aislado.sh" } as const;
const TEST_HOOKS = ["DIRECTOR_PAUSA_EN", "DIRECTOR_PAUSA_DIR"];

export function resolveMontageEngine(d: EngineDeps): EngineChoice {
  const raw = d.env.PODCAST_MONTAGE_ENGINE?.trim() ?? "";
  if (raw === "" || raw === "legacy") return { ok: true, engine: "legacy" };
  if (raw !== "director") return { ok: false, engine: raw.slice(0, 40), errors: [{ code: "MONTAGE_ENGINE_UNKNOWN", message: "PODCAST_MONTAGE_ENGINE solo admite «legacy» o «director»" }] };
  const errors: EngineError[] = [];
  const dir = d.env.PODCAST_DIRECTOR_DIR?.trim() ?? "";
  if (!dir || !path.isAbsolute(dir)) errors.push({ code: "DIRECTOR_ENV_MISSING", message: "falta PODCAST_DIRECTOR_DIR (ruta absoluta al paquete del Director compilado)" });
  else {
    const missing = Object.values(DIRECTOR_FILES).filter((f) => !d.exists(path.join(dir, f)));
    if (missing.length) errors.push({ code: "DIRECTOR_MODULE_MISSING", message: `faltan en PODCAST_DIRECTOR_DIR: ${missing.join(", ")}` });
  }
  if (!d.exists(d.runner)) errors.push({ code: "DIRECTOR_MODULE_MISSING", message: "falta scripts/podcast-director-step.cjs" });
  if (!d.onPath("bwrap")) errors.push({ code: "DIRECTOR_ISOLATION_MISSING", message: "falta bubblewrap (bwrap): el Director no se ejecuta sin aislamiento" });
  const want = d.env.PODCAST_DIRECTOR_UID?.trim() ?? "";
  if (d.uid === null || d.uid === 0 || !/^[1-9][0-9]*$/.test(want) || Number(want) !== d.uid) errors.push({ code: "DIRECTOR_UID_NOT_DEDICATED", message: "el worker debe correr con el UID dedicado declarado en PODCAST_DIRECTOR_UID (nunca root)" });
  const hooks = TEST_HOOKS.filter((k) => d.env[k] !== undefined);
  if (hooks.length) errors.push({ code: "DIRECTOR_TEST_HOOKS_SET", message: `variables solo de prueba definidas: ${hooks.join(", ")}` });
  if (!d.exists("/proc/self/fd")) errors.push({ code: "DIRECTOR_PROC_MISSING", message: "el Director necesita Linux con /proc" });
  if (errors.length) return { ok: false, engine: "director", errors };
  return { ok: true, engine: "director", runtime: { dir, adapter: path.join(dir, DIRECTOR_FILES.adapter), isolate: path.join(dir, DIRECTOR_FILES.isolate), runner: d.runner } };
}

/** Public, owner-facing text for a stop of the engine (codes only; no paths or values). */
export function engineBlockMessage(errors: EngineError[]): string {
  const codes = [...new Set(errors.map((e) => e.code))].join(", ");
  return `El montaje con el Director no está disponible (${codes}). No se ha hecho ningún gasto en este paso; revisa la configuración o usa el montaje estándar.`.slice(0, 500);
}

export type WorkerShot = { sceneIndex: number; file: string; seconds: number; size: number; sha256: string; kind: "video" | "photo"; credit: string; pageUrl?: string; sourceId?: string };
export type RightsBasis = { status: "cleared" | "unknown" | "restricted"; basis: string };
/** Reviewed, versioned server-side decision on the rights of a stock asset. None exists yet: the worker passes null. */
export type RightsPolicy = { id: string; version: string; basisFor: (p: ShotProvenance) => RightsBasis | null };
/** What the server knows about where an asset came from (provider metadata + the worker's own derivative). Not a permit. */
export type ShotProvenance = { asset: string; provider: "pexels"; sourceId: string | null; pageUrl: string | null; credit: string; derivative: string; size: number; sha256: string };

export function shotProvenance(inputDir: string, sh: WorkerShot): ShotProvenance {
  return {
    asset: path.relative(inputDir, sh.file), provider: "pexels", sourceId: sh.sourceId ?? null, pageUrl: sh.pageUrl ?? null, credit: sh.credit,
    derivative: sh.kind === "photo" ? "foto animada por el worker (renderPhotoFfmpeg)" : "clip recortado por el worker (renderClipFfmpeg)", size: sh.size, sha256: sh.sha256,
  };
}
export type DirectorRequestInput = {
  episodeId: string; version: number; title: string; language: "es" | "en"; inputDir: string;
  audio: { path: string; size: number; sha256: string }; audioSeconds: number; sampleRate: number | null;
  scenes: Array<{ start: number; end: number; text: string }>;
  shots: Array<WorkerShot | null>;
  subtitles: { path: string; size: number; sha256: string } | null;
  /** Measured (ffprobe) per shot file, keyed by absolute file path; a missing entry stays missing. */
  dimensions: Record<string, { width: number; height: number } | null>;
};
export type DirectorRequest = {
  schema: "atomivid/podcast-director-step@1";
  worker: Omit<DirectorRequestInput, "dimensions" | "sampleRate" | "shots"> & { sampleRate: 44100 | 48000; shots: Array<WorkerShot | null> };
  dimensions: Record<string, { width: number; height: number }>;
  rights: Record<string, RightsBasis>;
  provenance: ShotProvenance[];
  requireAvatarSegments: string[];
};

/** Serialisable request for the child runner. Rights only from an explicit policy; without one they stay empty (the adapter blocks). */
export function directorRequest(w: DirectorRequestInput, policy: RightsPolicy | null = null): { ok: true; request: DirectorRequest } | { ok: false; errors: EngineError[] } {
  if (w.sampleRate !== 44100 && w.sampleRate !== 48000) return { ok: false, errors: [{ code: "DIRECTOR_AUDIO_SAMPLE_RATE", message: "el audio debe ser de 44,1 o 48 kHz (medido con ffprobe)" }] };
  const dimensions: DirectorRequest["dimensions"] = {};
  for (const sh of w.shots) {
    const dim = sh ? w.dimensions[sh.file] : null;
    if (sh && dim && Number.isInteger(dim.width) && Number.isInteger(dim.height) && dim.width > 0 && dim.height > 0) dimensions[path.relative(w.inputDir, sh.file)] = { width: dim.width, height: dim.height };
  }
  const provenance = w.shots.filter((sh): sh is WorkerShot => !!sh).map((sh) => shotProvenance(w.inputDir, sh));
  const rights: DirectorRequest["rights"] = {};
  if (policy) for (const p of provenance) { const b = policy.basisFor(p); if (b) rights[p.asset] = b; }
  const worker: DirectorRequest["worker"] = {
    episodeId: w.episodeId, version: Math.max(1, w.version), title: w.title, language: w.language, inputDir: w.inputDir,
    audio: w.audio, audioSeconds: w.audioSeconds, sampleRate: w.sampleRate, scenes: w.scenes, shots: w.shots, subtitles: w.subtitles,
  };
  return { ok: true, request: { schema: "atomivid/podcast-director-step@1", worker, dimensions, rights, provenance, requireAvatarSegments: [] } };
}

/**
 * Command that runs the runner inside the Director's isolation. The work root (mode 700) is the only writable path; the
 * package, the runner and node are bound read-only explicitly, so they stay visible even under the wrapper's tmpfs /tmp.
 */
export function directorCommand(rt: DirectorRuntime, workDir: string, requestPath: string): { cmd: string; args: string[] } {
  return { cmd: "bash", args: [rt.isolate, "--rw", workDir, ...readOnlyBinds(rt), "--", process.execPath, rt.runner, rt.dir, requestPath] };
}

/** Same launch as directorCommand, but the runner only checks it can run there (see podcast-director-step.cjs --probe). */
export function directorProbeCommand(rt: DirectorRuntime, probeDir: string): { cmd: string; args: string[] } {
  return { cmd: "bash", args: [rt.isolate, "--rw", probeDir, ...readOnlyBinds(rt), "--", process.execPath, rt.runner, "--probe", rt.dir, probeDir] };
}

function readOnlyBinds(rt: DirectorRuntime): string[] {
  const dirs = [...new Set([rt.dir, path.dirname(rt.runner), path.dirname(process.execPath)])];
  return dirs.flatMap((d) => ["--ro", d]);
}

export type GateDeps = EngineDeps & {
  /** True when this production will search stock (the same condition the worker uses for buildSceneShots). */
  stockEnabled: boolean;
  rightsPolicy: RightsPolicy | null;
  /** Fresh private (0700) directory for the probe, and its removal. */
  makeProbeDir: () => Promise<string>;
  removeProbeDir: (dir: string) => Promise<void>;
  exec: (cmd: string, args: string[], env: Record<string, string>) => Promise<{ code: number; stdout: string }>;
};

/**
 * Everything that can be decided before any paid step: engine choice, known missing inputs and a real launch of the
 * isolation (bwrap executable, namespaces allowed, package readable inside, writes outside the work root refused).
 */
export async function montageGate(d: GateDeps): Promise<EngineChoice> {
  const choice = resolveMontageEngine(d);
  if (!choice.ok || choice.engine === "legacy") return choice;
  if (d.stockEnabled && !d.rightsPolicy) {
    return { ok: false, engine: "director", errors: [{ code: "DIRECTOR_RIGHTS_UNAVAILABLE", message: "no hay una política de derechos registrada para el material de stock; el Director lo rechazaría después de narrar" }] };
  }
  let probeDir: string | null = null;
  try {
    probeDir = await d.makeProbeDir();
    const { cmd, args } = directorProbeCommand(choice.runtime, probeDir);
    const res = await d.exec(cmd, args, directorChildEnv(d.env));
    const probe = parseProbeOutput(res.code, res.stdout);
    if (!probe.ok) return { ok: false, engine: "director", errors: [probe.error] };
  } catch {
    return { ok: false, engine: "director", errors: [{ code: "DIRECTOR_ISOLATION_PROBE_FAILED", message: "no se pudo lanzar la prueba de aislamiento" }] };
  } finally {
    if (probeDir) await d.removeProbeDir(probeDir).catch(() => undefined);
  }
  return choice;
}

export function parseProbeOutput(code: number, stdout: string): { ok: true } | { ok: false; error: EngineError } {
  let j: { status?: unknown; checks?: unknown; failed?: unknown } = {};
  try { j = JSON.parse(stdout.trim().split("\n").pop() ?? "") ?? {}; } catch { j = {}; }
  if (code === 0 && j.status === "probe-ok") return { ok: true };
  const failed = Array.isArray(j.failed) ? j.failed.filter((x): x is string => typeof x === "string").slice(0, 8).join(", ") : "";
  return { ok: false, error: { code: "DIRECTOR_ISOLATION_PROBE_FAILED", message: failed ? `prueba de aislamiento fallida: ${failed}` : `la prueba de aislamiento terminó con código ${code}` } };
}

/** Child environment: no credentials, no test hooks; only what node and the wrapper need. */
export function directorChildEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["PATH", "LANG", "LC_ALL", "TZ"]) if (env[k] !== undefined) out[k] = env[k] as string;
  return out;
}

export type DirectorOutcome = { ok: true; manifestSha256: string } | { ok: false; errors: EngineError[] };

export function parseDirectorOutput(code: number, stdout: string): DirectorOutcome {
  let j: unknown;
  try { j = JSON.parse(stdout.trim().split("\n").pop() ?? ""); } catch { j = null; }
  const o = (j && typeof j === "object" ? j : {}) as { status?: unknown; manifestSha256?: unknown; blockers?: unknown };
  if (o.status === "ready" && code === 0 && typeof o.manifestSha256 === "string" && /^[0-9a-f]{64}$/.test(o.manifestSha256)) return { ok: true, manifestSha256: o.manifestSha256 };
  if ((o.status === "blocked" || o.status === "error") && Array.isArray(o.blockers)) {
    const errors = o.blockers
      .filter((b): b is { code: string; message?: unknown } => !!b && typeof (b as { code?: unknown }).code === "string")
      .map((b) => ({ code: b.code.slice(0, 60), message: typeof b.message === "string" ? b.message.slice(0, 300) : "" }));
    if (errors.length) return { ok: false, errors };
  }
  return { ok: false, errors: [code === 0 ? { code: "DIRECTOR_OUTPUT_INVALID", message: "salida del Director ilegible" } : { code: "DIRECTOR_EXIT", message: `el Director terminó con código ${code}` }] };
}
