"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { summarizeDryRunResponse, type DryRunDisplayState } from "@/lib/video/long-form/visual-test-v2-display";

/**
 * UI administrativa MÍNIMA y TEMPORAL. Hace EXCLUSIVAMENTE una cosa: un
 * POST a /api/long-form/visual-test-v2 con el body LITERAL fijo
 * `{ mode: "dry_run" }` — nunca un valor dinámico, nunca leído de un
 * input. No hay ningún campo de formulario (prompt, cantidad, costo,
 * modo) en este componente: no hay nada que el usuario pueda escribir
 * que llegue a la request. Real generation NO tiene ningún botón ni
 * código aquí — ver visual-test-v2-runtime.ts (VISUAL_TEST_V2_REAL_MODE_LOCKED).
 */
export function DryRunButton() {
  const [state, setState] = useState<DryRunDisplayState>({ kind: "idle" });

  async function runDryRun() {
    setState({ kind: "loading" });
    let httpStatus: number;
    let body: unknown;
    try {
      const res = await fetch("/api/long-form/visual-test-v2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "dry_run" }),
      });
      httpStatus = res.status;
      body = await res.json().catch(() => null);
    } catch {
      setState({ kind: "error", httpStatus: 0, message: "No se pudo contactar al servidor. Intenta de nuevo." });
      return;
    }
    setState(summarizeDryRunResponse(httpStatus, body));
  }

  return (
    <div className="space-y-4">
      <Button type="button" onClick={runDryRun} loading={state.kind === "loading"}>
        Ejecutar Dry Run Long Form
      </Button>

      {state.kind === "error" && (
        <p role="alert" className="text-sm text-danger">
          Error (estado {state.httpStatus}): {state.message}
        </p>
      )}

      {state.kind === "report" && (
        <div role="status" className="space-y-3 rounded-lg border border-border-strong p-4 text-sm">
          <p>
            <strong>OPENAI_API_KEY disponible:</strong> {state.openaiApiKeyAvailable ? "true" : "false"}
          </p>
          <p>
            <strong>Shots del manifest ({state.shots.length}):</strong>
          </p>
          <ul className="list-disc space-y-1 pl-5">
            {state.shots.map((shot) => (
              <li key={shot.shotId}>
                {shot.shotId} — generaría: {shot.wouldGenerate ? "sí" : "no"} — costo estimado: ${shot.estimatedCostUsd.toFixed(4)}
              </li>
            ))}
          </ul>
          <p>
            <strong>Costo estimado total:</strong> ${state.estimatedTotalUsd.toFixed(4)} (tope Visual Test V2: ${state.maxTotalUsd.toFixed(2)}, hard stop VIDEO #001: ${state.hardStopUsd.toFixed(2)})
          </p>
          <p>
            <strong>Dentro del cost guard:</strong> {state.withinCostGuard ? "sí" : "no"}
            {state.costGuardBlockReason ? ` — ${state.costGuardBlockReason}` : ""}
          </p>
          <p>
            <strong>REAL mode bloqueado:</strong> {state.realModeLocked ? "true" : "false"}
          </p>
          <p>
            <strong>Llamadas pagadas realizadas:</strong> {state.paidApisCalled ? "true" : "false"}
          </p>
        </div>
      )}
    </div>
  );
}
