"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/Alert";

type Check = {
  outcome: "ready" | "customer_limit" | "provider_unavailable" | "unverifiable" | "needs_correction";
  responsible: "nadie" | "cliente" | "atomicvid";
  title: string;
  message: string;
  next: string;
  estimate: { stage: "before_script" | "before_render"; ceilingUsd: number; note: string } | null;
  checkedAt: string;
};

const TONE: Record<Check["outcome"], "info" | "warning" | "danger"> = {
  ready: "info", customer_limit: "warning", provider_unavailable: "warning", unverifiable: "warning", needs_correction: "danger",
};
const WHO: Record<Check["responsible"], string> = {
  nadie: "", cliente: "Quién lo resuelve: tú.", atomicvid: "Quién lo resuelve: Atomicvid (no es un problema de tu cuenta).",
};

/**
 * Control de costos (2026-10-18): «¿puedo hacer esta producción?» shown BEFORE the user presses anything.
 * Read-only: GET /api/generate/[id]/readiness never reserves, generates or calls a generative provider.
 * The start endpoints run the same check again on the server; this notice never authorises spend.
 */
export function ProductionReadinessNotice({ requestId }: { requestId: string }) {
  const [check, setCheck] = useState<Check | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch(`/api/generate/${requestId}/readiness`, { cache: "no-store" })
      .then(async (res) => (await res.json()) as { check?: Check })
      .then((body) => { if (alive) { if (body.check) setCheck(body.check); else setFailed(true); } })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [requestId]);

  if (failed) {
    return (
      <div className="my-3" data-testid="production-readiness">
        <Alert tone="warning">No pudimos comprobar ahora los recursos de esta producción. Al iniciar se vuelve a comprobar en el servidor; si no se confirma, no se gasta nada.</Alert>
      </div>
    );
  }
  if (!check) return <p className="my-3 text-sm text-ink-muted" role="status" data-testid="production-readiness">Comprobando plan y capacidad de producción…</p>;
  return (
    <div className="my-3" data-testid="production-readiness" data-outcome={check.outcome}>
      <Alert tone={TONE[check.outcome]}>
        <p className="font-medium">{check.title}</p>
        <p className="mt-1">{check.message}</p>
        {WHO[check.responsible] && <p className="mt-1">{WHO[check.responsible]}</p>}
        <p className="mt-1">{check.next}</p>
        {check.estimate && check.estimate.ceilingUsd > 0 && (
          <p className="mt-1 text-xs text-ink-muted">{check.estimate.note}</p>
        )}
      </Alert>
    </div>
  );
}
