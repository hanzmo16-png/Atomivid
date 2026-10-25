/**
 * Correcciones del propietario por trabajo de guion. Se importan de forma estática (empaquetadas con el worker): fusionar
 * el archivo es la aprobación del propietario. Un trabajo sin entrada aquí no cambia.
 */
import e8048599 from "../../../../content/long-form/e8048599/correcciones.json";
import { applyOwnerCorrections, type OwnerCorrections, type PersistedScript } from "./owner-corrections";

const REGISTRY: Record<string, { source: string; corrections: OwnerCorrections }> = {
  [e8048599.job]: { source: "content/long-form/e8048599/correcciones.json", corrections: e8048599 as OwnerCorrections },
};

export class OwnerCorrectionsError extends Error {
  constructor(readonly errors: string[]) { super(`Las correcciones del propietario no se pudieron aplicar: ${errors.slice(0, 3).join("; ").slice(0, 600)}`); this.name = "OwnerCorrectionsError"; }
}

export function ownerCorrectionsFor(jobId: string) { return REGISTRY[jobId] ?? null; }

/** Applies the registered corrections of THIS job (all or nothing). A job without corrections is returned as is. */
export function withOwnerCorrections<T extends PersistedScript>(jobId: string, script: T): T {
  const entry = ownerCorrectionsFor(jobId);
  if (!entry) return script;
  if (entry.corrections.job !== jobId) throw new OwnerCorrectionsError(["las correcciones pertenecen a otro trabajo"]);
  const r = applyOwnerCorrections(script, entry.corrections, entry.source);
  if (!r.ok) throw new OwnerCorrectionsError(r.errors);
  console.warn("[atomivid:owner-corrections]", JSON.stringify({ job: jobId.slice(0, 8), digest: r.record!.digest, narration: r.record!.narration.length, claims: r.record!.claims.length, reviewQuotes: r.record!.reviewQuotesUpdated, wordDelta: r.record!.wordDelta }));
  return r.script as T;
}
