/**
 * Mystery Shopper 2.0 — trabajos persistentes sin migraciones.
 *
 * Mismo patrón que Audio Podcast Studio: JSON en el bucket privado existente («videos») bajo un prefijo propio del
 * módulo. Nada aquí vive en /tmp. La atomicidad sale de Storage: subir con `upsert: false` falla con 409 si el objeto ya
 * existe (índice único de storage.objects), así que crear `job.json` es una reserva atómica entre instancias y crear
 * `claim-<n>.json` deja a UN solo worker por intento.
 *
 *   runs/<id>/job.json        solicitud inmutable (creación atómica = idempotencia del botón y del disparo de CI)
 *   runs/<id>/claim-<n>.json  quién ejecuta el intento n (creación atómica = exclusión entre workers)
 *   runs/<id>/status.json     estado vivo (solo lo escribe quien tiene el claim vigente)
 *   runs/<id>/report.json     informe final, inmutable
 *   runs/<id>/evidence/*      capturas, registro de acciones y archivos medidos, inmutables
 */
import type { ProductId, ProfileId } from "./types";

export const MS_BUCKET = "videos";
export const MS_PREFIX = "mystery-shopper/v2";
/** Un worker sin latido durante este tiempo se considera caído: otro puede tomar el intento siguiente. */
export const STALE_MS = 10 * 60_000;
/** Intentos de worker por trabajo (reinicios incluidos). Al agotarse, el trabajo queda en error, no se relanza solo. */
export const MAX_ATTEMPTS = 3;

const JOB_ID = /^ms-[a-z0-9][a-z0-9-]{7,90}$/;
const EVIDENCE = /^[a-z0-9][a-z0-9._-]{0,80}\.(png|json|txt|mp3|mp4|webm|log)$/;

export function assertJobId(id: string): string {
  if (!JOB_ID.test(id) || id.includes("--")) throw new JobError("Id de evaluación no válido.");
  return id;
}
export function newJobId(now: Date, rand: () => string): string {
  const t = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "z").toLowerCase();
  return assertJobId(`ms-${t}-${rand().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10).padEnd(6, "0")}`);
}

export type Target = { kind: "production" | "preview" | "local"; url: string };
export type JobSource = "panel" | "ci";
export type JobMode = "gratuito" | "real";

export type Job = {
  v: 2;
  id: string;
  missionId: string;
  product: ProductId;
  profile: ProfileId;
  mode: JobMode;
  target: Target;
  source: JobSource;
  requestedBy: string;
  requestedAt: string;
  /** SHA que se pidió evaluar (CI) o el del servidor que recibió el clic. El worker anota el SHA que realmente vio. */
  requestedSha: string;
  maxBudgetUsd: number;
};

export type JobState = "en_cola" | "en_proceso" | "terminada" | "bloqueada" | "error";

export type JobStatus = {
  state: JobState;
  stage: string;
  attempt: number;
  runnerId: string | null;
  heartbeatAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Evidencia de sesión nueva: id aleatorio del contexto de navegador y versión del navegador. */
  browser: { sessionId: string; version: string; freshContext: boolean } | null;
  workerRunUrl: string | null;
  error: string | null;
  updatedAt: string;
  /** Resumen del informe para el panel (el informe completo está en report.json). */
  result?: { verdict: string; score: number | null; coverage: string; findings: number; critical: string | null; humanGate: string | null } | null;
};

export type JobView = { job: Job; status: JobStatus; hasReport: boolean };

export class JobError extends Error { constructor(m: string) { super(m); this.name = "JobError"; } }

type StorageError = { message: string; statusCode?: string | number } | null;
export type StorageApi = {
  list(prefix: string, opts: { limit: number; offset?: number }): Promise<{ data: { name: string }[] | null; error: StorageError }>;
  download(path: string): Promise<{ data: Blob | null; error: StorageError }>;
  upload(path: string, body: string | Blob | Buffer, opts: { contentType: string; upsert: boolean; cacheControl?: string }): Promise<{ error: StorageError }>;
  createSignedUrl?(path: string, seconds: number, opts?: { download?: string | boolean }): Promise<{ data: { signedUrl: string } | null; error: unknown }>;
};

const notFound = (e: StorageError) => !!e && (String(e.statusCode) === "404" || /not.?found|does not exist/i.test(e.message ?? ""));
const conflict = (e: StorageError) => !!e && (String(e.statusCode) === "409" || /already exists|duplicate/i.test(e.message ?? ""));

const dir = (id: string) => `${MS_PREFIX}/runs/${assertJobId(id)}`;
export const evidencePath = (id: string, name: string) => {
  if (!EVIDENCE.test(name)) throw new JobError("Nombre de evidencia no válido.");
  return `${dir(id)}/evidence/${name}`;
};

export function queuedStatus(now: string): JobStatus {
  return { state: "en_cola", stage: "Esperando al worker", attempt: 0, runnerId: null, heartbeatAt: null, startedAt: null, finishedAt: null, browser: null, workerRunUrl: null, error: null, updatedAt: now };
}

export type ClaimResult =
  | { ok: true; attempt: number }
  | { ok: false; reason: "terminado" | "en_curso" | "agotado" | "no_existe"; detail: string };

export function jobStore(bucket: StorageApi) {
  const readJson = async <T>(path: string): Promise<T | null> => {
    const { data, error } = await bucket.download(path);
    if (error) { if (notFound(error)) return null; throw new JobError(`No se pudo leer ${path.split("/").pop()}.`); }
    if (!data) return null;
    try { return JSON.parse(await data.text()) as T; } catch { return null; }
  };
  const createOnly = async (path: string, body: string | Buffer, contentType = "application/json"): Promise<boolean> => {
    const { error } = await bucket.upload(path, body, { contentType, upsert: false, cacheControl: "0" });
    if (conflict(error)) return false;
    if (error) throw new JobError(`No se pudo guardar ${path.split("/").pop()} (${error.statusCode ?? "?"}).`);
    return true;
  };
  const overwrite = async (path: string, body: string) => {
    const { error } = await bucket.upload(path, body, { contentType: "application/json", upsert: true, cacheControl: "0" });
    if (error) throw new JobError(`No se pudo actualizar ${path.split("/").pop()}.`);
  };
  const names = async (prefix: string, limit = 1000) => {
    const { data, error } = await bucket.list(prefix, { limit });
    if (error) throw new JobError("No se pudo listar el historial.");
    return (data ?? []).map((o) => o.name);
  };

  const store = {
    /** Reserva atómica: solo la primera solicitud con este id crea el trabajo. Las demás reciben el existente. */
    async reserve(job: Job, now: string): Promise<{ created: boolean; view: JobView }> {
      assertJobId(job.id);
      const created = await createOnly(`${dir(job.id)}/job.json`, JSON.stringify(job));
      if (created) await createOnly(`${dir(job.id)}/status.json`, JSON.stringify(queuedStatus(now))).catch(() => false);
      const view = await store.get(job.id);
      if (!view) throw new JobError("La reserva no se pudo leer de vuelta.");
      return { created, view };
    },
    async get(id: string): Promise<JobView | null> {
      const job = await readJson<Job>(`${dir(id)}/job.json`);
      if (!job) return null;
      const status = (await readJson<JobStatus>(`${dir(id)}/status.json`)) ?? queuedStatus(job.requestedAt);
      const files = await names(dir(id));
      return { job, status, hasReport: files.includes("report.json") };
    },
    async list(limit = 50): Promise<JobView[]> {
      const ids = (await names(`${MS_PREFIX}/runs`)).filter((n) => JOB_ID.test(n));
      const views = await Promise.all(ids.map((id) => store.get(id).catch(() => null)));
      return views.filter((v): v is JobView => !!v).sort((a, b) => b.job.requestedAt.localeCompare(a.job.requestedAt)).slice(0, limit);
    },
    /**
     * Toma el trabajo para un intento. El intento n solo lo gana quien crea `claim-n.json` (atómico). Si ya hay un
     * informe, no se repite; si el intento vigente tiene latido reciente, no se pisa; si su worker murió, se toma el
     * siguiente intento hasta MAX_ATTEMPTS.
     */
    async claim(id: string, runnerId: string, nowMs: number): Promise<ClaimResult> {
      const view = await store.get(id);
      if (!view) return { ok: false, reason: "no_existe", detail: "El trabajo no existe." };
      if (view.hasReport || ["terminada", "bloqueada", "error"].includes(view.status.state)) return { ok: false, reason: "terminado", detail: "Ya tiene resultado: no se repite." };
      const claims = (await names(dir(id))).filter((n) => /^claim-\d+\.json$/.test(n)).map((n) => Number(n.slice(6, -5)));
      const last = claims.length ? Math.max(...claims) : 0;
      if (last > 0) {
        const beat = Date.parse(view.status.heartbeatAt ?? view.status.updatedAt);
        if (Number.isFinite(beat) && nowMs - beat < STALE_MS) return { ok: false, reason: "en_curso", detail: `El intento ${last} sigue vivo.` };
      }
      const next = last + 1;
      if (next > MAX_ATTEMPTS) return { ok: false, reason: "agotado", detail: `Se agotaron los ${MAX_ATTEMPTS} intentos.` };
      const won = await createOnly(`${dir(id)}/claim-${next}.json`, JSON.stringify({ runnerId, at: new Date(nowMs).toISOString() }));
      if (!won) return { ok: false, reason: "en_curso", detail: `Otro worker tomó el intento ${next}.` };
      return { ok: true, attempt: next };
    },
    /** Solo quien tiene el claim vigente escribe el estado (se comprueba antes de escribir). */
    async setStatus(id: string, runnerId: string, status: JobStatus): Promise<void> {
      const claims = (await names(dir(id))).filter((n) => /^claim-\d+\.json$/.test(n)).map((n) => Number(n.slice(6, -5)));
      const last = claims.length ? Math.max(...claims) : 0;
      const owner = last ? await readJson<{ runnerId: string }>(`${dir(id)}/claim-${last}.json`) : null;
      if (!owner || owner.runnerId !== runnerId) throw new JobError("Este worker ya no tiene el trabajo.");
      await overwrite(`${dir(id)}/status.json`, JSON.stringify(status));
    },
    async putReport(id: string, report: unknown): Promise<boolean> {
      return createOnly(`${dir(id)}/report.json`, JSON.stringify(report));
    },
    async getReport<T>(id: string): Promise<T | null> { return readJson<T>(`${dir(id)}/report.json`); },
    async putEvidence(id: string, name: string, data: Buffer | string, contentType: string): Promise<string> {
      const p = evidencePath(id, name);
      await createOnly(p, data, contentType);
      return p;
    },
    async evidence(id: string): Promise<string[]> { return (await names(`${dir(id)}/evidence`)).filter((n) => EVIDENCE.test(n)); },
    async evidenceUrl(id: string, name: string, seconds = 900): Promise<string | null> {
      if (!bucket.createSignedUrl) return null;
      const { data } = await bucket.createSignedUrl(evidencePath(id, name), seconds);
      return data?.signedUrl ?? null;
    },
    /** Registro de despachos: cuenta cuántas veces se intentó encolar el worker (acotado). */
    async recordDispatch(id: string, n: number, detail: unknown): Promise<boolean> {
      return createOnly(`${dir(id)}/dispatch-${n}.json`, JSON.stringify(detail));
    },
    async markDispatchOk(id: string, n: number): Promise<boolean> {
      return createOnly(`${dir(id)}/dispatch-${n}-ok.json`, JSON.stringify({ ok: true }));
    },
    async markDispatchFailed(id: string, n: number, detail: string): Promise<boolean> {
      return createOnly(`${dir(id)}/dispatch-${n}-fail.json`, JSON.stringify({ ok: false, detail }));
    },
    /** count = despachos pedidos; ok = confirmados; failed = fallidos de forma explícita (los demás siguen en vuelo). */
    async dispatchState(id: string): Promise<{ count: number; ok: number; failed: number }> {
      const files = await names(dir(id));
      return {
        count: files.filter((n) => /^dispatch-\d+\.json$/.test(n)).length,
        ok: files.filter((n) => /^dispatch-\d+-ok\.json$/.test(n)).length,
        failed: files.filter((n) => /^dispatch-\d+-fail\.json$/.test(n)).length,
      };
    },
  };
  return store;
}
export type JobStore = ReturnType<typeof jobStore>;

/** Storage en memoria con la misma semántica (409 atómico) para pruebas unitarias. */
export function memoryBucket(): StorageApi & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  const toBuf = async (b: string | Blob | Buffer) => (typeof b === "string" ? Buffer.from(b) : Buffer.isBuffer(b) ? b : Buffer.from(await b.arrayBuffer()));
  return {
    objects,
    async list(prefix, opts) {
      const p = prefix.endsWith("/") ? prefix : `${prefix}/`;
      const seen = new Set<string>();
      for (const k of objects.keys()) if (k.startsWith(p)) seen.add(k.slice(p.length).split("/")[0]);
      return { data: [...seen].sort().slice(0, opts.limit).map((name) => ({ name })), error: null };
    },
    async download(path) {
      const b = objects.get(path);
      return b ? { data: new Blob([new Uint8Array(b)]), error: null } : { data: null, error: { message: "Object not found", statusCode: "404" } };
    },
    async upload(path, body, opts) {
      // Comprobar y escribir en el mismo turno, sin await entre medias: atómico dentro del proceso.
      if (!opts.upsert && objects.has(path)) return { error: { message: "The resource already exists", statusCode: "409" } };
      const placeholder = Buffer.alloc(0);
      if (!opts.upsert) objects.set(path, placeholder);
      const buf = await toBuf(body);
      objects.set(path, buf);
      return { error: null };
    },
    async createSignedUrl(path) { return objects.has(path) ? { data: { signedUrl: `memory://${path}` }, error: null } : { data: null, error: "404" }; },
  };
}
