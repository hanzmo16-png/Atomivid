/**
 * Acciones del guion con IA sobre un proyecto de Audio Podcast Studio (rutas /api/audio-studio/projects/[id]/guion).
 *
 *  iniciar  — comprueba tema, duración y voces del proyecto GUARDADO y crea el trabajo (sin llamar a la IA).
 *  paso     — avanza un paso (escaleta o bloque) y guarda el progreso en el proyecto; al terminar escribe el guion.
 *  cancelar — detiene el trabajo sin tocar el guion (lo pagado queda en el libro; nada se borra).
 *
 * La escritura con IA no consume créditos de voz: el audio se sigue generando aparte, con autorización expresa y
 * después de la validación previa (readinessIssues). Mientras la IA escribe, el proyecto no se puede editar ni generar.
 */
import { randomUUID } from "node:crypto";
import { generationActive, isUuid, voicePreset, type AudioProject } from "./model";
import type { ProjectStore } from "./store";
import { view, type ProjectView, type Result } from "./service";
import type { VoiceAvailability } from "./voice";
import {
  advanceScriptJob, assembleScript, blockCount, newScriptJob, scriptJobActive, ScriptAiError, stepsDone, totalSteps,
  type ScriptAiInput, type ScriptJob,
} from "./script-ai";
import type { ScriptAiAvailability } from "./script-llm";
import { supplyBlockMessage, type SupplyPolicyInfo } from "@/lib/podcast/v3/supply-message";

export type ScriptDeps = {
  store: ProjectStore; now?: () => string; newId?: () => string; env?: Record<string, string | undefined>; voice?: VoiceAvailability;
  ai: ScriptAiAvailability;
  /** Gasto de guion con IA de esta cuenta en las últimas 24 h (USD); lanza si el libro no responde. */
  scriptSpend?: () => Promise<number>;
  supplyPolicy?: () => Promise<SupplyPolicyInfo | null>;
};
type Body = { error: string; code?: string; recoverable?: boolean; current?: ProjectView; resetAt?: string };
export type ScriptResult = Result<ProjectView & { scriptStep?: { done: boolean; step: number; steps: number; phase: string } }> | { ok: false; status: number; body: Body };

const nowOf = (d: ScriptDeps) => (d.now ?? (() => new Date().toISOString()))();
const DEFAULT_TITLE = /^(episodio sin t[ií]tulo|untitled)$/i;

/** Tope diario de guion con IA por persona (USD en 24 h; AUDIO_STUDIO_SCRIPT_DAILY_USD, 2 por defecto, entre 0,5 y 20). */
export function scriptDailyCapUsd(env: Record<string, string | undefined>): number {
  const v = Number(env.AUDIO_STUDIO_SCRIPT_DAILY_USD);
  return Number.isFinite(v) && v > 0 ? Math.min(20, Math.max(0.5, v)) : 2;
}

export function scriptInputOf(p: AudioProject): ScriptAiInput {
  return {
    topic: p.title.trim().slice(0, 300), notes: p.notes.trim().slice(0, 2000), minutes: p.targetMinutes, voiceCount: p.voiceCount, language: p.language,
    voiceNames: p.voices.slice(0, p.voiceCount).map((v) => voicePreset(v)?.label ?? "Voz"),
  };
}

/** Qué impide empezar a escribir con IA (vacío = se puede). */
export function scriptStartIssues(p: AudioProject, now: number): string[] {
  const out: string[] = [];
  if (p.archivedAt) out.push("El proyecto está archivado. Restáuralo para escribir el guion.");
  if (generationActive(p.generation, now)) out.push("Se está generando el audio: espera a que termine.");
  const t = p.title.trim();
  if (t.length < 3 || DEFAULT_TITLE.test(t)) out.push("Escribe el tema del episodio en el título (por ejemplo «Las líneas y momias de Nazca»).");
  if (p.voices.slice(0, p.voiceCount).some((v) => voicePreset(v)?.language !== p.language)) out.push("Elige voces del idioma seleccionado.");
  return out;
}

const fail = (status: number, error: string, extra: Omit<Body, "error"> = {}): ScriptResult => ({ ok: false, status, body: { error, ...extra } });
const stepInfo = (j: ScriptJob, done: boolean, phase: string) => ({ done, step: stepsDone(j), steps: totalSteps(j), phase });

/** Guarda el trabajo releyendo el proyecto justo antes (cualquier otro cambio del proyecto se conserva). */
async function persistJob(d: ScriptDeps, ownerId: string, id: string, from: ScriptJob, mutate: (cur: AudioProject) => AudioProject): Promise<AudioProject | null> {
  const cur = await d.store.get(ownerId, id);
  if (!cur || cur.scriptJob?.jobId !== from.jobId) return null;
  // Otra pestaña ya avanzó o cerró este trabajo: no se retrocede (lo pagado es lo mismo; el libro no cobra dos veces).
  if (cur.scriptJob.status !== "en_curso" || stepsDone(cur.scriptJob) !== stepsDone(from)) return cur;
  const next = mutate(cur);
  await d.store.put(next);
  return next;
}

export async function scriptAction(d: ScriptDeps, ownerId: string, id: string, body: unknown): Promise<ScriptResult> {
  try {
    return await run(d, ownerId, id, body);
  } catch (e) {
    return fail(503, e instanceof Error && e.name === "StoreError" ? e.message : "No se pudo guardar el avance del guion. Reintenta: lo ya escrito se conserva.", { recoverable: true });
  }
}

async function run(d: ScriptDeps, ownerId: string, id: string, body: unknown): Promise<ScriptResult> {
  const b = (body && typeof body === "object" ? body : {}) as { action?: unknown; revision?: unknown; jobId?: unknown };
  const cur = isUuid(id) ? await d.store.get(ownerId, id) : null;
  if (!cur) return fail(404, "Proyecto no encontrado.");
  const now = nowOf(d), nowMs = Date.parse(now);
  const v = (p: AudioProject) => view(p, d.env, d.voice);

  if (b.action === "cancelar") {
    if (!scriptJobActive(cur.scriptJob)) return { ok: true, status: 200, body: v(cur) };
    const next: AudioProject = { ...cur, scriptJob: { ...cur.scriptJob!, status: "cancelado", updatedAt: now, error: null } };
    await d.store.put(next);
    return { ok: true, status: 200, body: v(next) };
  }

  if (b.action === "iniciar") {
    if (d.ai.mode === "off") return fail(503, d.ai.reason, { code: "IA_NO_DISPONIBLE", current: v(cur) });
    if (scriptJobActive(cur.scriptJob)) return fail(409, "La IA ya está escribiendo el guion de este episodio.", { code: "EN_CURSO", current: v(cur) });
    if (b.revision !== cur.revision) return fail(409, "Guarda los cambios antes de escribir el guion con IA.", { code: "REVISION", current: v(cur) });
    const issues = scriptStartIssues(cur, nowMs);
    if (issues.length) return fail(422, issues[0], { code: "DATOS", current: v(cur) });
    const job = newScriptJob((d.newId ?? randomUUID)(), scriptInputOf(cur), now);
    const next: AudioProject = { ...cur, scriptJob: job };
    await d.store.put(next);
    return { ok: true, status: 201, body: { ...v(next), scriptStep: stepInfo(job, false, "inicio") } };
  }

  if (b.action !== "paso") return fail(400, "Acción no reconocida.");
  const job = cur.scriptJob;
  if (!job || job.status !== "en_curso") return fail(409, "No hay un guion con IA en curso para este episodio.", { code: "SIN_TRABAJO", current: v(cur) });
  if (typeof b.jobId === "string" && b.jobId !== job.jobId) return fail(409, "Ese guion con IA ya no es el actual (¿otra pestaña?). Recarga para ver el estado.", { code: "OTRO_TRABAJO", current: v(cur) });
  if (d.ai.mode === "off") return fail(503, d.ai.reason, { code: "IA_NO_DISPONIBLE", current: v(cur), recoverable: true });

  // Tope diario por persona (además de los topes global y del proveedor que aplica el libro de gastos).
  if (d.scriptSpend) {
    const cap = scriptDailyCapUsd(d.env ?? process.env);
    let used: number;
    try { used = await d.scriptSpend(); } catch { return fail(503, "No se pudo comprobar tu gasto de IA de hoy; no se llamó a la IA. Reintenta en unos minutos.", { code: "IA_FALLO", recoverable: true, current: v(cur) }); }
    if (used >= cap) return fail(429, `Alcanzaste el límite diario de guiones con IA (USD ${cap.toFixed(2)} en 24 h). Lo ya escrito se conserva: podrás continuar cuando lo gastado en las últimas 24 h baje de ese monto.`, { code: "LIMITE_DIARIO", recoverable: true, current: v(cur) });
  }

  try {
    const r = await advanceScriptJob(job, d.ai.step(job.jobId), now, d.ai.replay?.(job.jobId) ?? undefined);
    const saved = await persistJob(d, ownerId, id, job, (p) => {
      if (!r.done) return { ...p, scriptJob: r.job };
      // Terminado: el guion completo reemplaza al anterior (la persona lo confirmó al iniciar) y sigue siendo editable.
      // El texto vive en el guion del proyecto; el trabajo conserva la escaleta y el resultado (sin duplicar el texto).
      return { ...p, script: assembleScript(r.job), scriptJob: { ...r.job, blocks: [] }, status: "borrador", revision: p.revision + 1, updatedAt: now };
    });
    if (!saved) return fail(409, "El guion con IA cambió en otra pestaña. Recarga para ver el estado.", { code: "OTRO_TRABAJO", current: v(cur) });
    return { ok: true, status: 200, body: { ...v(saved), scriptStep: stepInfo(r.job, r.done, r.phase) } };
  } catch (e) {
    if (e instanceof ScriptAiError) {
      const kept = e.job ?? job;
      const saved = await persistJob(d, ownerId, id, job, (p) => ({ ...p, scriptJob: { ...kept, updatedAt: now, error: e.code === "AGOTADO" ? e.message : null, note: e.code === "INVALIDO" ? e.message : null } }));
      const status = e.code === "AGOTADO" ? 409 : 422;
      return fail(status, e.message, { code: e.code, recoverable: e.recoverable, current: saved ? v(saved) : v(cur) });
    }
    const f = describeFailure(e);
    if (f.code.startsWith("supply:")) {
      let policy: SupplyPolicyInfo | null = null;
      try { policy = d.supplyPolicy ? await d.supplyPolicy() : null; } catch { policy = null; }
      const m = supplyBlockMessage(f.code.slice("supply:".length), policy);
      return fail(f.status, m.error, { code: "IA_FALLO", recoverable: true, current: v(cur), ...(m.resetAt ? { resetAt: m.resetAt } : {}) });
    }
    console.error("audio-studio script-step", { job: job.jobId, step: job.plan ? `b${job.blocks.length}` : "plan", detail: f.code });
    return fail(f.status, f.error, { code: f.code === "in-flight" ? "PASO_EN_CURSO" : "IA_FALLO", recoverable: true, current: v(cur) });
  }
}

/** Error del modelo o del control de gasto → mensaje claro y recuperable (nunca plantilla). */
export function describeFailure(e: unknown): { status: number; error: string; code: string } {
  const err = e as { name?: string; message?: string; status?: number; reason?: string };
  const name = String(err?.name ?? ""), msg = String(err?.message ?? "");
  if (name === "SupplyUnavailableError" || msg.startsWith("SUPPLY_UNAVAILABLE:")) {
    const reason = msg.split(":").slice(2).join(":") || String(err.reason ?? "");
    return { status: 503, error: "La IA no pudo empezar este paso por el control de gasto. No se cobró nada y lo ya escrito se conserva.", code: `supply:${reason.slice(0, 60)}` };
  }
  if (name === "SubmissionInFlightError") return { status: 409, error: "Ese paso ya se está escribiendo (¿otra pestaña?). Espera un momento: nunca se paga dos veces.", code: "in-flight" };
  if (/Reconciliation/i.test(name)) return { status: 409, error: "Una llamada de este guion quedó sin confirmar con el proveedor; por seguridad no se repite hasta reconciliarla. Lo ya escrito se conserva: reintenta más tarde.", code: "reconciliation" };
  if (name === "PaidLedgerUnavailableError" || name === "ScriptLedgerUnavailableError") return { status: 503, error: "No se pudo registrar el gasto de la llamada; no se llamó a la IA. Reintenta en unos minutos.", code: "ledger" };
  if (typeof err?.status === "number") return { status: 502, error: `La IA respondió con un error (${err.status}). No se usó ninguna plantilla; lo ya escrito se conserva y puedes reintentar.`, code: `provider:${err.status}` };
  return { status: 502, error: "La IA no respondió. No se usó ninguna plantilla; lo ya escrito se conserva y puedes reintentar.", code: `error:${name.slice(0, 40) || "desconocido"}` };
}

export { blockCount };
