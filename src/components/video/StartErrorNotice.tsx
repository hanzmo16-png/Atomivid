"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/Alert";

const key = (requestId: string) => `atomivid:start-error:${requestId}`;

/**
 * Carries a start failure from the configure page to the video page (per tab, never in the URL).
 * Storage can be unavailable (private mode): then the video page simply shows its normal next step.
 */
export function rememberStartError(requestId: string, message: string) {
  try { sessionStorage.setItem(key(requestId), message.slice(0, 600)); } catch { /* best effort */ }
}

/**
 * The next step the notice names must exist on the page for the request's CURRENT status: a confirmed plan
 * that never left `script_ready` shows «Iniciar producción»; a start whose worker trigger failed is already
 * `failed` (the attempt counts) and the page offers «Reintentar». Any other status: the notice is stale.
 */
export function startErrorNextStep(status: string, retryAvailable: boolean): string | null {
  if (status === "script_ready") return "No se generó ningún cargo. Puedes volver a pulsar «Iniciar producción».";
  if (status === "failed") return retryAvailable
    ? "No se generó ningún cargo. Puedes volver a intentarlo con «Reintentar» (usa uno de los intentos disponibles)."
    : "No se generó ningún cargo. Ya no quedan intentos para este plan.";
  return null;
}

export function StartErrorNotice({ requestId, status, retryAvailable }: { requestId: string; status: string; retryAvailable: boolean }) {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    try {
      const value = sessionStorage.getItem(key(requestId));
      if (value) {
        sessionStorage.removeItem(key(requestId));
        // Read once from per-tab storage after mount (not available during server render).
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setMessage(value);
      }
    } catch { /* storage unavailable */ }
  }, [requestId]);
  const nextStep = startErrorNextStep(status, retryAvailable);
  if (!message || !nextStep) return null;
  return (
    <Alert tone="warning" role="alert">
      <p className="font-medium">El plan quedó confirmado, pero la producción no se inició.</p>
      <p className="mt-1">{message}</p>
      <p className="mt-1">{nextStep}</p>
    </Alert>
  );
}
