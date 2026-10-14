"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Alert } from "@/components/ui/Alert";
import { outcomeApplies, parseStartOutcome, startNoticeText, type StartOutcome } from "@/lib/video/start-outcome";

const key = (requestId: string) => `atomivid:start-error:${requestId}`;

export type StoredStart = { message: string; outcome: StartOutcome };
type Current = { status: string; attempts: number };

/**
 * Carries a start failure from the configure page to the video page (per tab, never in the URL), with the
 * server's typed outcome when it sent one. Storage can be unavailable (private mode): then the video page
 * simply shows its normal next step.
 */
export function rememberStartError(requestId: string, message: string, outcome: StartOutcome | null = null) {
  try { sessionStorage.setItem(key(requestId), JSON.stringify({ message: message.slice(0, 600), outcome })); } catch { /* best effort */ }
}

/** Without a server outcome the notice is pinned to the state it was read in, with an unknown charge. */
export function captureOutcome(outcome: StartOutcome | null, status: string, attempts: number): StartOutcome {
  return outcome ?? { retry: "available", charge: "unknown", status, attempts };
}

function readStored(raw: string, current: Current): StoredStart | null {
  try {
    const v = JSON.parse(raw) as { message?: unknown; outcome?: unknown };
    if (typeof v.message !== "string" || !v.message) return null;
    return { message: v.message, outcome: captureOutcome(parseStartOutcome(v.outcome), current.status, current.attempts) };
  } catch { return null; }
}

const StartContext = createContext<{ stored: StoredStart | null; current: Current } | null>(null);

/**
 * Reads the carried failure once per request and shares it with the notice and every start/retry action of the
 * page, so both follow the same typed outcome. `initial` lets a static render (tests) supply it.
 */
export function StartOutcomeProvider({ requestId, status, attempts, initial = null, children }: {
  requestId: string; status: string; attempts: number; initial?: StoredStart | null; children: ReactNode;
}) {
  const [stored, setStored] = useState<StoredStart | null>(initial);
  useEffect(() => {
    try {
      const value = sessionStorage.getItem(key(requestId));
      if (value) {
        sessionStorage.removeItem(key(requestId));
        // Read once from per-tab storage after mount (not available during server render). The captured
        // state must not follow later refreshes: only a new request id reads again.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setStored(readStored(value, { status, attempts }));
      }
    } catch { /* storage unavailable */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId]);
  return <StartContext.Provider value={{ stored, current: { status, attempts } }}>{children}</StartContext.Provider>;
}

/** The carried outcome, only while it still describes the request (same status and attempt). */
function useApplicableOutcome(): StartOutcome | null {
  const ctx = useContext(StartContext);
  return ctx && outcomeApplies(ctx.stored?.outcome ?? null, ctx.current) ? ctx.stored!.outcome : null;
}

/**
 * Shown once, only for the state it was written for. `supportRequired`: the typed action the server stored
 * with the request's failure (see failure-action.ts).
 */
export function StartErrorNotice({ retryAvailable, supportRequired = false }: { retryAvailable: boolean; supportRequired?: boolean }) {
  const ctx = useContext(StartContext);
  if (!ctx?.stored) return null;
  return <StartErrorNoticeView message={ctx.stored.message} outcome={ctx.stored.outcome} current={{ ...ctx.current, retryAvailable, supportRequired }} />;
}

export function StartErrorNoticeView({ message, outcome, current }: {
  message: string; outcome: StartOutcome | null; current: { status: string; attempts: number; retryAvailable: boolean; supportRequired?: boolean };
}) {
  const nextStep = startNoticeText(current, outcome);
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

export const SUPPORT_HOLD_TEXT =
  "Repetir ahora no lo resolverá. Contacta al soporte con el código; tu solicitud y los intentos restantes se conservan.";

/**
 * Wraps a start or retry action: hidden while the carried outcome for this exact state requires support.
 * Outside a provider (history list, static pages) it renders the action unchanged.
 */
export function StartActionGate({ children }: { children: ReactNode }) {
  const outcome = useApplicableOutcome();
  if (outcome?.retry === "support") return <p role="status" className="text-sm text-ink-muted">{SUPPORT_HOLD_TEXT}</p>;
  return <>{children}</>;
}
