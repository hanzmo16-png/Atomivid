"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Alert } from "@/components/ui/Alert";
import { outcomeApplies, parseStartOutcome, startNoticeText, type StartOutcome } from "@/lib/video/start-outcome";

const key = (requestId: string) => `atomivid:start-error:${requestId}`;

export type StoredStart = { message: string; outcome: StartOutcome };
type Current = { status: string; attempts: number };

/**
 * Carries a start failure from the configure page to the video page (per tab and per request, never in the URL),
 * with the server's typed outcome when it sent one. Storage can be unavailable (private mode): then the video page
 * simply shows its normal next step.
 */
export function rememberStartError(requestId: string, message: string, outcome: StartOutcome | null = null) {
  try { sessionStorage.setItem(key(requestId), JSON.stringify({ message: message.slice(0, 600), outcome })); } catch { /* best effort */ }
}

/** Without a server outcome the notice is pinned to the state it was read in, with an unknown charge. */
export function captureOutcome(outcome: StartOutcome | null, status: string, attempts: number): StartOutcome {
  return outcome ?? { retry: "available", charge: "unknown", status, attempts };
}

/**
 * What the page keeps from this request's stored entry, for its CURRENT state:
 * - an outcome that still describes this status and attempt is kept (and survives reload / navigation in the tab);
 * - one written for another status or attempt is stale and removed;
 * - an entry carried without a server outcome is pinned to the state it is first read in (and rewritten so).
 */
export function resolveStoredStart(raw: string | null, current: Current): { stored: StoredStart | null; write: boolean; remove: boolean } {
  if (!raw) return { stored: null, write: false, remove: false };
  let v: { message?: unknown; outcome?: unknown };
  try { v = JSON.parse(raw) as typeof v; } catch { return { stored: null, write: false, remove: true }; }
  if (typeof v.message !== "string" || !v.message) return { stored: null, write: false, remove: true };
  const parsed = parseStartOutcome(v.outcome);
  const stored = { message: v.message, outcome: captureOutcome(parsed, current.status, current.attempts) };
  if (!outcomeApplies(stored.outcome, current)) return { stored: null, write: false, remove: true };
  return { stored, write: parsed === null, remove: false };
}

type Ctx = { stored: StoredStart | null; loaded: boolean; current: Current; report: (stored: StoredStart) => void; clear: () => void };
const StartContext = createContext<Ctx | null>(null);

/**
 * A start pressed on this page that the server refused with a typed outcome for the CURRENT state: it becomes
 * the page's outcome (same as one carried from the configure page). null when it does not describe this state.
 */
export function reportedStart(message: string, outcome: StartOutcome | null, current: Current): StoredStart | null {
  return outcome && outcomeApplies(outcome, current) ? { message, outcome } : null;
}

/** For start buttons inside the page provider: hand a refused start's outcome to the page (no-op outside one). */
export function useReportStartOutcome(): ((message: string, outcome: StartOutcome | null) => boolean) | null {
  const ctx = useContext(StartContext);
  if (!ctx) return null;
  return (message, outcome) => {
    const stored = reportedStart(message, outcome, ctx.current);
    if (stored) ctx.report(stored);
    return stored !== null;
  };
}

/**
 * Shares this request's stored start outcome with the notice and every start/retry action of the page, so both
 * follow the same typed outcome. The entry lives in sessionStorage under this request's id until it goes stale
 * (status or attempt changed) or the owner clears it after support. Until it has been read (server render and
 * hydration) the gated actions are not offered. `initial` lets a static render (tests) supply a read result.
 */
export function StartOutcomeProvider({ requestId, status, attempts, initial, children }: {
  requestId: string; status: string; attempts: number; initial?: StoredStart | null; children: ReactNode;
}) {
  const [state, setState] = useState<{ stored: StoredStart | null; loaded: boolean }>({ stored: initial ?? null, loaded: initial !== undefined });
  useEffect(() => {
    let stored: StoredStart | null = null;
    try {
      const result = resolveStoredStart(sessionStorage.getItem(key(requestId)), { status, attempts });
      if (result.remove) sessionStorage.removeItem(key(requestId));
      if (result.write && result.stored) sessionStorage.setItem(key(requestId), JSON.stringify(result.stored));
      stored = result.stored;
    } catch { /* storage unavailable: the page shows its normal next step */ }
    // Per-tab storage exists only after mount; re-read on every request, status or attempt change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ stored, loaded: true });
  }, [requestId, status, attempts]);
  const report = (stored: StoredStart) => {
    try { sessionStorage.setItem(key(requestId), JSON.stringify(stored)); } catch { /* still shown in this view */ }
    setState({ stored, loaded: true });
  };
  const clear = () => {
    try { sessionStorage.removeItem(key(requestId)); } catch { /* nothing stored */ }
    setState({ stored: null, loaded: true });
  };
  return (
    <StartContext.Provider value={{ stored: state.stored, loaded: state.loaded, current: { status, attempts }, report, clear }}>
      {children}
    </StartContext.Provider>
  );
}

/** The carried outcome, only while it still describes the request (same status and attempt). */
function useApplicableOutcome(): StartOutcome | null {
  const ctx = useContext(StartContext);
  return ctx && outcomeApplies(ctx.stored?.outcome ?? null, ctx.current) ? ctx.stored!.outcome : null;
}

/**
 * Shown while the stored outcome still describes the request's state (it survives reload and navigation in the
 * tab and goes away once the status or attempt changes). `supportRequired`: the typed action the server stored
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
 * Wraps a start or retry action: hidden while the stored outcome for this exact state requires support, and not
 * offered before that outcome has been read. "Soporte ya lo resolvió" only forgets this request's stored outcome
 * (no request, no reservation, no provider): the action reappears, and if the cause persists the server answers
 * support again and the block comes back. Outside a provider (history list, static pages) the action is unchanged.
 */
export function StartActionGate({ children }: { children: ReactNode }) {
  const ctx = useContext(StartContext);
  const outcome = useApplicableOutcome();
  if (ctx && !ctx.loaded) return <p aria-busy="true" className="text-sm text-ink-faint">Comprobando el estado de la producción…</p>;
  if (outcome?.retry === "support") {
    return (
      <div className="flex flex-col items-center gap-2" data-testid="support-hold">
        <p role="status" className="text-sm text-ink-muted">{SUPPORT_HOLD_TEXT}</p>
        <button type="button" onClick={ctx!.clear} className="text-xs font-medium text-accent underline hover:text-accent-hover">
          Soporte ya lo resolvió
        </button>
        <p className="text-xs text-ink-faint">Solo vuelve a mostrar la acción en esta pestaña; no inicia nada.</p>
      </div>
    );
  }
  return <>{children}</>;
}
