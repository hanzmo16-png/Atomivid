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

export function StartErrorNotice({ requestId }: { requestId: string }) {
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
  if (!message) return null;
  return (
    <Alert tone="warning" role="alert">
      <p className="font-medium">El plan quedó confirmado, pero la producción no se inició.</p>
      <p className="mt-1">{message}</p>
      <p className="mt-1">No se generó ningún cargo. Puedes volver a pulsar «Iniciar producción».</p>
    </Alert>
  );
}
