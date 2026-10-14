import { classifyRenderFailure, generateDiagnosticId, logRenderError } from "./render-error";
import type { StartOutcome } from "./start-outcome";

/**
 * A start that failed before any reservation, dispatch or state change (e.g. the worker configuration is
 * missing): the request keeps its status and attempts, nothing ran, and the typed action says whether repeating helps.
 */
export function preReservationFailure(error: unknown, unchanged: StartOutcome): { body: { error: string; outcome: StartOutcome }; status: number } {
  const diagnosticId = generateDiagnosticId();
  logRenderError("POST /render (antes de reservar)", error, diagnosticId);
  const { message, action } = classifyRenderFailure(error, diagnosticId);
  return {
    body: { error: message, outcome: { ...unchanged, charge: "none_proven", retry: action === "support" ? "support" : "available" } },
    status: 500,
  };
}
