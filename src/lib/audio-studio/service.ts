import { createHash, randomUUID } from "node:crypto";
import {
  applyInput, estimate, generationActive, isUuid, musicPlan, newProject, readinessIssues, ValidationError, voiceRate,
  type AudioProject, type Estimate, type MusicSection, type ProjectInput,
} from "./model";
import { PAID_BLOCKED, type VoiceAvailability } from "./voice";
import type { ProjectStore } from "./store";
import { SEED_EPISODE } from "./seed";

export type Result<T> = { ok: true; status: number; body: T } | { ok: false; status: number; body: { error: string; field?: string; current?: ProjectView } };
export type ProjectView = AudioProject & { estimate: Estimate; musicPlan: MusicSection[]; readiness: string[] };

export function view(p: AudioProject, env: Record<string, string | undefined> = process.env): ProjectView {
  const e = estimate(p, voiceRate(env));
  return { ...p, estimate: e, musicPlan: musicPlan(p.script, p.music), readiness: readinessIssues(p, e) };
}

const fail = (status: number, error: string, extra: { field?: string; current?: ProjectView } = {}) => ({ ok: false as const, status, body: { error, ...extra } });
const NOT_FOUND = () => fail(404, "Proyecto no encontrado.");

function guard<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
  return fn().catch((e: unknown) => {
    if (e instanceof ValidationError) return fail(400, e.message, { field: e.field });
    return fail(503, e instanceof Error && e.name === "StoreError" ? e.message : "El estudio no pudo completar la operación. Inténtalo de nuevo.");
  });
}

export type Deps = { store: ProjectStore; now?: () => string; newId?: () => string; env?: Record<string, string | undefined> };
const nowOf = (d: Deps) => (d.now ?? (() => new Date().toISOString()))();

export const listProjects = (d: Deps, ownerId: string) => guard(async () => {
  const all = await d.store.list(ownerId);
  return { ok: true, status: 200, body: { projects: all.map((p) => view(p, d.env)) } };
});

export const getProject = (d: Deps, ownerId: string, id: string) => guard(async () => {
  const p = isUuid(id) ? await d.store.get(ownerId, id) : null;
  return p ? { ok: true, status: 200, body: view(p, d.env) } : NOT_FOUND();
});

export const createProject = (d: Deps, ownerId: string, input: unknown) => guard(async () => {
  const i = (input && typeof input === "object" ? input : {}) as { title?: unknown; voiceCount?: unknown };
  const voiceCount = i.voiceCount === 2 ? 2 : 1;
  const title = typeof i.title === "string" && i.title.trim() ? i.title : "Episodio sin título";
  const p = newProject({ id: (d.newId ?? randomUUID)(), ownerId, now: nowOf(d), title, voiceCount });
  if (!(await d.store.create(p))) return fail(409, "El proyecto ya existe.");
  return { ok: true, status: 201, body: view(p, d.env) };
});

/** Guardado con control de revisión: si otra pestaña guardó antes, no se pisa su trabajo (409 con la versión actual). */
export const saveProject = (d: Deps, ownerId: string, id: string, body: unknown) => guard(async () => {
  const cur = isUuid(id) ? await d.store.get(ownerId, id) : null;
  if (!cur) return NOT_FOUND();
  const b = (body && typeof body === "object" ? body : null) as ({ revision?: unknown } & ProjectInput) | null;
  if (!b || typeof b.revision !== "number") return fail(400, "Falta la revisión del proyecto.", { field: "revision" });
  if (cur.archivedAt) return fail(409, "El proyecto está archivado. Restáuralo para editarlo.", { current: view(cur, d.env) });
  if (generationActive(cur.generation, Date.parse(nowOf(d)))) return fail(409, "Se está generando el audio: espera a que termine para editar.", { current: view(cur, d.env) });
  if (b.revision !== cur.revision) return fail(409, "El proyecto cambió en otra pestaña o dispositivo. Recarga para ver la última versión.", { current: view(cur, d.env) });
  const { title, voiceCount, voices, targetMinutes, script, notes, music, budgetUsd } = b;
  const next = applyInput(cur, { title, voiceCount, voices, targetMinutes, script, notes, music, budgetUsd }, nowOf(d));
  await d.store.put(next);
  return { ok: true, status: 200, body: view(next, d.env) };
});

/** Archivar no borra nada: solo marca la fecha. Restaurar la quita. */
export const setArchived = (d: Deps, ownerId: string, id: string, archived: boolean) => guard(async () => {
  const cur = isUuid(id) ? await d.store.get(ownerId, id) : null;
  if (!cur) return NOT_FOUND();
  if (!!cur.archivedAt === archived) return { ok: true, status: 200, body: view(cur, d.env) };
  if (generationActive(cur.generation, Date.parse(nowOf(d)))) return fail(409, "Se está generando el audio: espera a que termine.", { current: view(cur, d.env) });
  const next: AudioProject = { ...cur, archivedAt: archived ? nowOf(d) : null, revision: cur.revision + 1, updatedAt: nowOf(d) };
  await d.store.put(next);
  return { ok: true, status: 200, body: view(next, d.env) };
});

/** Deja el proyecto «listo para autorizar». No llama a ningún proveedor ni reserva gasto. */
export const markReady = (d: Deps, ownerId: string, id: string, revision: unknown) => guard(async () => {
  const cur = isUuid(id) ? await d.store.get(ownerId, id) : null;
  if (!cur) return NOT_FOUND();
  if (revision !== cur.revision) return fail(409, "Guarda los cambios antes de marcarlo como listo.", { current: view(cur, d.env) });
  if (generationActive(cur.generation, Date.parse(nowOf(d)))) return fail(409, "Se está generando el audio: espera a que termine.", { current: view(cur, d.env) });
  const v = view(cur, d.env);
  if (v.readiness.length) return fail(422, v.readiness[0], { current: v });
  const next: AudioProject = { ...cur, status: "listo_para_autorizar", revision: cur.revision + 1, updatedAt: nowOf(d) };
  await d.store.put(next);
  return { ok: true, status: 200, body: view(next, d.env) };
});

export const GENERATION_BLOCKED = PAID_BLOCKED;

const unavailable = (v: VoiceAvailability | undefined) => (!v ? PAID_BLOCKED : v.ok ? null : v.reason);

/**
 * Generar el MP3. Exige autorización expresa: `confirmUsd` debe ser exactamente el costo estimado mostrado y caber en
 * el tope del episodio. Si el proveedor de voz no está disponible (producción sin autorización de gasto), responde 409
 * sin tocar nada. Solo deja el trabajo en cola: el worker hace el resto.
 */
export const requestGeneration = (d: Deps & { voice?: VoiceAvailability }, ownerId: string, id: string, body: unknown = {}) => guard(async () => {
  const cur = isUuid(id) ? await d.store.get(ownerId, id) : null;
  if (!cur) return NOT_FOUND();
  const why = unavailable(d.voice);
  if (why) return fail(409, why, { current: view(cur, d.env) });
  const b = (body && typeof body === "object" ? body : {}) as { revision?: unknown; confirmUsd?: unknown };
  if (cur.archivedAt) return fail(409, "El proyecto está archivado. Restáuralo para generar.", { current: view(cur, d.env) });
  const now = nowOf(d);
  if (generationActive(cur.generation, Date.parse(now))) return fail(409, "Ya hay una generación en curso para este episodio.", { current: view(cur, d.env) });
  if (b.revision !== cur.revision) return fail(409, "Guarda los cambios antes de generar.", { current: view(cur, d.env) });
  const v = view(cur, d.env);
  if (v.readiness.length) return fail(422, v.readiness[0], { current: v });
  const confirm = typeof b.confirmUsd === "number" ? b.confirmUsd : NaN;
  if (!(Math.abs(confirm - v.estimate.estimatedUsd) < 0.005)) return fail(400, `Confirma el gasto estimado exacto (USD ${v.estimate.estimatedUsd.toFixed(2)}) para generar. No se hizo ningún cargo.`, { field: "confirmUsd", current: v });
  if (cur.spentUsd + confirm > cur.budgetUsd + 1e-9) return fail(422, `El gasto autorizado más lo ya gastado supera el tope del episodio (USD ${cur.budgetUsd.toFixed(2)}).`, { current: v });
  const next: AudioProject = { ...cur, generation: { ...cur.generation, status: "en_cola", kind: "generar", error: null, progress: null, startedAt: null, finishedAt: null, heartbeatAt: now,
    authorization: { usd: confirm, revision: cur.revision, at: now, spentBefore: cur.spentUsd } } };
  await d.store.put(next);
  return { ok: true, status: 202, body: view(next, d.env) };
});

/** Remezclar la música sin regenerar la voz: usa solo la voz en caché (costo 0, sin autorización de gasto). */
export const requestRemix = (d: Deps & { voice?: VoiceAvailability }, ownerId: string, id: string, body: unknown = {}) => guard(async () => {
  const cur = isUuid(id) ? await d.store.get(ownerId, id) : null;
  if (!cur) return NOT_FOUND();
  const why = unavailable(d.voice);
  if (why) return fail(409, why, { current: view(cur, d.env) });
  const b = (body && typeof body === "object" ? body : {}) as { revision?: unknown };
  const now = nowOf(d);
  if (!cur.audio) return fail(409, "Primero genera el audio; la remezcla reutiliza esa voz.", { current: view(cur, d.env) });
  if (generationActive(cur.generation, Date.parse(now))) return fail(409, "Ya hay una generación en curso para este episodio.", { current: view(cur, d.env) });
  if (b.revision !== cur.revision) return fail(409, "Guarda los cambios antes de remezclar.", { current: view(cur, d.env) });
  const next: AudioProject = { ...cur, generation: { ...cur.generation, status: "en_cola", kind: "remezclar", error: null, progress: null, startedAt: null, finishedAt: null, heartbeatAt: now } };
  await d.store.put(next);
  return { ok: true, status: 202, body: view(next, d.env) };
});

/** Reanudar tras un fallo o una interrupción: misma autorización y misma revisión; la voz ya generada no se vuelve a pagar. */
export const resumeGeneration = (d: Deps & { voice?: VoiceAvailability }, ownerId: string, id: string) => guard(async () => {
  const cur = isUuid(id) ? await d.store.get(ownerId, id) : null;
  if (!cur) return NOT_FOUND();
  const why = unavailable(d.voice);
  if (why) return fail(409, why, { current: view(cur, d.env) });
  const now = nowOf(d), g = cur.generation;
  const interrupted = g.status === "fallida" || ((g.status === "en_cola" || g.status === "generando") && !generationActive(g, Date.parse(now)));
  if (!interrupted) return fail(409, "No hay una generación interrumpida que reanudar.", { current: view(cur, d.env) });
  if (g.kind === "generar" && g.authorization?.revision !== cur.revision) return fail(409, "El guion cambió desde la autorización: vuelve a autorizar el gasto.", { current: view(cur, d.env) });
  const next: AudioProject = { ...cur, generation: { ...g, status: "en_cola", error: null, heartbeatAt: now, finishedAt: null } };
  await d.store.put(next);
  return { ok: true, status: 202, body: view(next, d.env) };
});

/** Id estable del episodio inicial de una cuenta: cargarlo dos veces nunca crea un duplicado. */
export function seedId(ownerId: string): string {
  const h = createHash("sha256").update(`audio-studio-seed-1:${ownerId}`).digest("hex").split("");
  h[12] = "4";
  h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** Carga el primer episodio como proyecto editable si la cuenta aún no lo tiene (ni archivado). Idempotente. */
export async function ensureSeed(d: Deps, ownerId: string): Promise<"created" | "exists"> {
  const id = seedId(ownerId);
  if (await d.store.get(ownerId, id)) return "exists";
  const now = nowOf(d);
  const base = newProject({ id, ownerId, now, title: SEED_EPISODE.title, voiceCount: 1 });
  const p = applyInput(base, {
    voices: [SEED_EPISODE.voice], targetMinutes: SEED_EPISODE.targetMinutes, script: SEED_EPISODE.script, notes: SEED_EPISODE.notes,
    music: SEED_EPISODE.music, budgetUsd: SEED_EPISODE.budgetUsd,
  }, now);
  return (await d.store.create({ ...p, revision: 1 })) ? "created" : "exists";
}
