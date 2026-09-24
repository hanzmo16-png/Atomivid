"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { summarizeRealRunResponse, type RealRunDisplayState } from "@/lib/video/long-form/visual-test-v2-real-display";
import { VISUAL_TEST_V2_REAL_CONFIRM_VALUE } from "@/lib/video/long-form/visual-test-v2-real-confirm";

/**
 * Segundo control, claramente separado del DRY_RUN — genera EXACTAMENTE
 * las 3 imágenes del Visual Test V2 con dinero real. `shotIds` /
 * `estimatedTotalUsd` / `maxTotalUsd` los calcula el servidor
 * (page.tsx, a partir del manifest real ya aprobado) y llegan aquí como
 * props de solo lectura — no hay ningún input en este componente, así que
 * no hay forma de editarlos desde el cliente. El POST manda
 * EXCLUSIVAMENTE el literal fijo { confirm: VISUAL_TEST_V2_REAL_CONFIRM_VALUE }
 * — nunca un prompt, cantidad, ni "mode" arbitrario.
 */
export function RealGenerateButton({
  shotIds,
  estimatedTotalUsd,
  maxTotalUsd,
}: {
  shotIds: readonly string[];
  estimatedTotalUsd: number;
  maxTotalUsd: number;
}) {
  const [state, setState] = useState<RealRunDisplayState>({ kind: "idle" });

  async function runReal() {
    const confirmed = window.confirm(
      `Vas a generar ${shotIds.length} imágenes REALES con OpenAI (costo estimado $${estimatedTotalUsd.toFixed(2)}, ` +
        `hard stop $${maxTotalUsd.toFixed(2)}). Esto consume dinero real. ¿Confirmas?`,
    );
    if (!confirmed) return;

    setState({ kind: "loading" });
    let httpStatus: number;
    let body: unknown;
    try {
      const res = await fetch("/api/long-form/visual-test-v2/real", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: VISUAL_TEST_V2_REAL_CONFIRM_VALUE }),
      });
      httpStatus = res.status;
      body = await res.json().catch(() => null);
    } catch {
      setState({ kind: "error", httpStatus: 0, message: "No se pudo contactar al servidor. Intenta de nuevo." });
      return;
    }
    setState(summarizeRealRunResponse(httpStatus, body));
  }

  return (
    <div className="space-y-4 rounded-lg border-2 border-danger/40 p-4">
      <div className="space-y-1 text-sm">
        <p className="font-semibold text-ink">Generación REAL (dinero real — OpenAI Images)</p>
        <p>
          {shotIds.length} imágenes: {shotIds.join(", ")}
        </p>
        <p>Costo estimado: US${estimatedTotalUsd.toFixed(2)}</p>
        <p>Hard stop: US${maxTotalUsd.toFixed(2)}</p>
      </div>

      <Button type="button" variant="danger" onClick={runReal} loading={state.kind === "loading"}>
        Generar 3 imágenes — máximo US$0.50
      </Button>

      {state.kind === "error" && (
        <p role="alert" className="text-sm text-danger">
          Error (estado {state.httpStatus}): {state.message}
        </p>
      )}

      {state.kind === "result" && (
        <div role="status" className="space-y-3 rounded-lg border border-border-strong p-4 text-sm">
          <ul className="list-disc space-y-1 pl-5">
            {state.shots.map((shot) => (
              <li key={shot.shotId}>
                {shot.shotId} — {shot.status === "generated" ? "generada ahora" : shot.status === "reused" ? "reutilizada (ya existía)" : "estado desconocido"} — costo: ${shot.costUsd.toFixed(4)}
              </li>
            ))}
          </ul>
          <p>
            <strong>Gastado en esta ejecución:</strong> ${state.totalSpentThisRunUsd.toFixed(4)}
          </p>
          <p>
            <strong>Total acumulado Visual Test V2:</strong> ${state.ledgerVisualTestV2SpentUsd.toFixed(4)} / ${state.maxTotalUsd.toFixed(2)}
          </p>
          <p>
            <strong>Total acumulado VIDEO #001:</strong> ${state.ledgerTotalSpentUsd.toFixed(4)} / ${state.hardStopUsd.toFixed(2)}
          </p>
          <p>
            <strong>Llamadas pagadas realizadas:</strong> {state.paidApisCalled ? "true" : "false"}
          </p>
        </div>
      )}
    </div>
  );
}
