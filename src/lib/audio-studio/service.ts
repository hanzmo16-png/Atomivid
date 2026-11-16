import { createHash, randomUUID } from "node:crypto";
import {
  applyInput, estimate, isUuid, musicPlan, newProject, readinessIssues, ValidationError, voiceRate,
  type AudioProject, type Estimate, type MusicSection, type ProjectInput,
} from "./model";
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
  const next: AudioProject = { ...cur, archivedAt: archived ? nowOf(d) : null, revision: cur.revision + 1, updatedAt: nowOf(d) };
  await d.store.put(next);
  return { ok: true, status: 200, body: view(next, d.env) };
});

/** Deja el proyecto «listo para autorizar». No llama a ningún proveedor ni reserva gasto. */
export const markReady = (d: Deps, ownerId: string, id: string, revision: unknown) => guard(async () => {
  const cur = isUuid(id) ? await d.store.get(ownerId, id) : null;
  if (!cur) return NOT_FOUND();
  if (revision !== cur.revision) return fail(409, "Guarda los cambios antes de marcarlo como listo.", { current: view(cur, d.env) });
  const v = view(cur, d.env);
  if (v.readiness.length) return fail(422, v.readiness[0], { current: v });
  const next: AudioProject = { ...cur, status: "listo_para_autorizar", revision: cur.revision + 1, updatedAt: nowOf(d) };
  await d.store.put(next);
  return { ok: true, status: 200, body: view(next, d.env) };
});

export const GENERATION_BLOCKED =
  "La generación real con ElevenLabs no está habilitada en Audio Podcast Studio 1.0. Requiere una autorización de gasto posterior; no se hizo ninguna llamada ni cargo.";

/** Generación pagada: bloqueada en 1.0. No hay ruta de código que llame al proveedor. */
export const requestGeneration = (d: Deps, ownerId: string, id: string) => guard(async () => {
  const cur = isUuid(id) ? await d.store.get(ownerId, id) : null;
  if (!cur) return NOT_FOUND();
  return fail(409, GENERATION_BLOCKED, { current: view(cur, d.env) });
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
