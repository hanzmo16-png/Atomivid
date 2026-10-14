"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { parseStartOutcome, startNoticeText, type StartOutcome } from "@/lib/video/start-outcome";

const key = (requestId: string) => `atomivid:start-error:${requestId}`;

type Stored = { message: string; outcome: StartOutcome | null };

/**
 * Carries a start failure from the configure page to the video page (per tab, never in the URL), with the
 * server's typed outcome when it sent one. Storage can be unavailable (private mode): then the video page
 * simply shows its normal next step.
 */
export function rememberStartError(requestId: string, message: string, outcome: StartOutcome | null = null) {
  try { sessionStorage.setItem(key(requestId), JSON.stringify({ message: message.slice(0, 600), outcome })); } catch { /* best effort */ }
}

function readStored(raw: string): Stored | null {
  try {
    const v = JSON.parse(raw) as { message?: unknown; outcome?: unknown };
    return typeof v.message === "string" && v.message ? { message: v.message, outcome: parseStartOutcome(v.outcome) } : null;
  } catch { return null; }
}

/** Without a server outcome the notice is pinned to the state it was read in, with an unknown charge. */
export function captureOutcome(outcome: StartOutcome | null, status: string, attempts: number): StartOutcome {
  return outcome ?? { retry: "available", charge: "unknown", status, attempts };
}

/**
 * Shown once, only for the state it was written for: with a server outcome, its status and attempt; without one,
 * the state the page had when the notice was read. Any later change (a retry started, a new failure) hides it for good.
 */
export function StartErrorNotice({ requestId, status, attempts, retryAvailable }: { requestId: string; status: string; attempts: number; retryAvailable: boolean }) {
  const [stored, setStored] = useState<Stored | null>(null);
  useEffect(() => {
    try {
      const value = sessionStorage.getItem(key(requestId));
      if (value) {
        sessionStorage.removeItem(key(requestId));
        const parsed = readStored(value);
        // Read once from per-tab storage after mount (not available during server render).
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (parsed) setStored({ message: parsed.message, outcome: captureOutcome(parsed.outcome, status, attempts) });
      }
    } catch { /* storage unavailable */ }
    // Only on a new request: the captured state must not follow later refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId]);
  if (!stored) return null;
  return <StartErrorNoticeView message={stored.message} outcome={stored.outcome} current={{ status, attempts, retryAvailable }} />;
}

export function StartErrorNoticeView({ message, outcome, current }: {
  message: string; outcome: StartOutcome | null; current: { status: string; attempts: number; retryAvailable: boolean };
}) {
  const nextStep = startNoticeText(current, message, outcome);
  if (!nextStep) return null;
  return (
    <Alert tone="warning" role="alert">
      <p className="font-medium">{outcome?.charge === "none_proven"
        ? "El plan quedó confirmado, pero la producción no se inició."
        : "El plan quedó confirmado, pero la producción no pudo iniciarse con normalidad."}</p>
      <p className="mt-1">{message}</p>
      <p className="mt-1">{nextStep}</p>
    </Alert>
  );
}
