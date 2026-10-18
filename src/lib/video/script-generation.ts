/**
 * The generation half of POST /api/generate/[id]/script, with its I/O injected so the whole response path
 * (success, double click, uncertain provider outcome, ledger outage) is testable without a server, a database or a
 * provider (script-intent.test.ts). The route only wires the real dependencies.
 */
import { SupplyUnavailableError } from "@/lib/supply/policy";
import { scriptBlockState, ScriptLedgerUnavailableError, ScriptReconciliationRequiredError, type ScriptOpRow } from "@/lib/supply/script-intent";
import { classifyScriptError, logScriptError } from "@/lib/video/script-error";
import { generateDiagnosticId } from "@/lib/video/render-error";
import type { GeneratedScript } from "@/lib/providers/types";

export type ScriptGenerationOutcome =
  | { status: 200; body: { status: "script_ready"; script: GeneratedScript } }
  | { status: 409 | 500 | 503; body: { error: string; reconciliation?: "in_flight" | "requires_reconciliation" }; headers?: Record<string, string> };

export const SCRIPT_LEDGER_UNAVAILABLE_MESSAGE = "El servicio de guiones no está disponible en este momento. No se hizo ningún cobro; intenta de nuevo en unos minutos.";

export async function runScriptGeneration(deps: {
  /** Generation + quality check, already inside withScriptGenerationContext. */
  generate: () => Promise<GeneratedScript>;
  /** persistScriptChange bound to the loaded request (its CAS errors propagate to the route's outer catch). */
  persist: (patch: Record<string, unknown>) => Promise<void>;
  /** supplyGuardRequired(): without the guard there is no ledger to consult. */
  guard: boolean;
  loadRows: () => Promise<ScriptOpRow[]>;
  now?: () => number;
}): Promise<ScriptGenerationOutcome> {
  let script: GeneratedScript;
  try {
    script = await deps.generate();
  } catch (error) {
    if (error instanceof SupplyUnavailableError) return { status: 503, body: { error: error.customerMessage }, headers: { "Retry-After": "300" } };
    if (error instanceof ScriptLedgerUnavailableError) return { status: 503, body: { error: SCRIPT_LEDGER_UNAVAILABLE_MESSAGE }, headers: { "Retry-After": "300" } };
    // A failure AFTER the provider call (parse, storage, network cut) leaves the ledger RECONCILIATION_REQUIRED
    // even when the error itself is generic: classify by the ledger, so the customer is told not to retry.
    const blocked = error instanceof ScriptReconciliationRequiredError ? error : await uncertainAfterFailure(deps);
    const diagnosticId = generateDiagnosticId();
    logScriptError("POST /script", error, diagnosticId);
    const message = classifyScriptError(blocked ?? error, diagnosticId);
    // Double click while the first generation runs: leave the request alone (the first one will settle it).
    if (blocked?.state === "in_flight") return { status: 409, body: { error: message, reconciliation: "in_flight" } };

    // script_json se limpia explícitamente: si esto fue una regeneración
    // completa desde "script_ready" que falló, dejar el guion anterior
    // haría que el botón "Reintentar" del historial (RequestCard) lo
    // interprete como "el render falló, el guion sigue siendo válido" y
    // ofrezca reintentar el render en vez del guion — justo el guion que
    // acabamos de rechazar.
    await deps.persist({ status: "failed", error_message: message, script_json: null });

    if (blocked) return { status: 409, body: { error: message, reconciliation: blocked.state } };
    return { status: 500, body: { error: message } };
  }

  await deps.persist({ status: "script_ready", script_json: script, error_message: null });
  return { status: 200, body: { status: "script_ready", script } };
}

/** Reads the ledger after a failed generation; a read failure is not hidden as "settled". */
export async function uncertainAfterFailure(deps: { guard: boolean; loadRows: () => Promise<ScriptOpRow[]>; now?: () => number }): Promise<ScriptReconciliationRequiredError | null> {
  if (!deps.guard) return null;
  const rows = await deps.loadRows().catch(() => null);
  if (!rows) return new ScriptReconciliationRequiredError("requires_reconciliation", "ledger unreadable after a failed call");
  const state = scriptBlockState(rows, (deps.now ?? Date.now)());
  return state ? new ScriptReconciliationRequiredError(state, "ledger state after a failed call") : null;
}
