"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/Alert";

export type ChecklistItemView = { id: string; label: string; status: "ok" | "warning" | "blocked" | "unverified" | "not_applicable"; detail: string; responsible: "nadie" | "cliente" | "atomicvid" };
export type CheckView = {
  outcome: "ready" | "customer_limit" | "provider_unavailable" | "unverifiable" | "needs_correction";
  responsible: "nadie" | "cliente" | "atomicvid";
  title: string;
  message: string;
  next: string;
  checklist?: ChecklistItemView[];
  estimate: { stage: "before_script" | "before_render"; ceilingUsd: number; note: string } | null;
  checkedAt: string;
};

const MARK: Record<ChecklistItemView["status"], { icon: string; label: string; className: string }> = {
  ok: { icon: "✓", label: "Correcto", className: "text-success" },
  warning: { icon: "!", label: "Atención", className: "text-warning" },
  blocked: { icon: "✕", label: "Bloquea", className: "text-danger" },
  unverified: { icon: "?", label: "Sin verificar", className: "text-warning" },
  not_applicable: { icon: "–", label: "No aplica", className: "text-ink-faint" },
};
const TONE: Record<CheckView["outcome"], "success" | "warning" | "danger"> = {
  ready: "success", customer_limit: "warning", provider_unavailable: "warning", unverifiable: "warning", needs_correction: "danger",
};
const WHO = { nadie: "", cliente: "Lo resuelves tú.", atomicvid: "Lo resuelve Atomicvid (no es tu cuenta)." } as const;

/** The server's answer, item by item. Shows only what the server checked; never a decorative animation. */
export function ChecklistView({ check, stale }: { check: CheckView; stale?: boolean }) {
  return (
    <div className="space-y-2" data-testid="production-checklist" data-outcome={check.outcome} aria-busy={stale || undefined}>
      <Alert tone={TONE[check.outcome]}>
        <p className="font-medium">{check.title}</p>
        <p className="mt-1">{check.message}</p>
        <p className="mt-1">{check.next}</p>
      </Alert>
      {check.checklist && (
        <ul className={`space-y-1.5 text-sm ${stale ? "opacity-60" : ""}`}>
          {check.checklist.map(item => (
            <li key={item.id} className="flex gap-2" data-item={item.id} data-status={item.status}>
              <span aria-label={MARK[item.status].label} className={`w-4 shrink-0 text-center font-semibold ${MARK[item.status].className}`}>{MARK[item.status].icon}</span>
              <span>
                <span className="font-medium text-ink">{item.label}</span>
                <span className="text-ink-muted"> — {item.detail}</span>
                {item.status !== "ok" && item.status !== "not_applicable" && WHO[item.responsible] && <span className="text-ink-muted"> {WHO[item.responsible]}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-ink-faint">Comprobado en el servidor {new Date(check.checkedAt).toLocaleTimeString()}. Se vuelve a comprobar al iniciar; si algo cambió, no se gasta nada.</p>
    </div>
  );
}

export type CheckState = { status: "idle" | "checking" | "done" | "failed"; check: CheckView | null; key: string | null };

/**
 * Asks POST /api/production-check (read-only) for the CURRENT form data. Any change of the data invalidates
 * the previous answer at once (it is never shown as current), older responses are discarded by key, and the
 * request is debounced so typing does not flood the server.
 */
export function useProductionCheck(payload: Record<string, unknown>, enabled: boolean): CheckState {
  const key = JSON.stringify(payload);
  const [state, setState] = useState<CheckState>({ status: "idle", check: null, key: null });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setState(s => ({ status: "checking", check: s.check, key: s.key }));
      fetch("/api/production-check", { method: "POST", headers: { "Content-Type": "application/json" }, body: key, signal: controller.signal, cache: "no-store" })
        .then(async res => (await res.json()) as { check?: CheckView })
        // The cleanup aborts this request as soon as the data changes, so only an answer for current data lands.
        .then(body => { if (!controller.signal.aborted) setState(body.check ? { status: "done", check: body.check, key } : { status: "failed", check: null, key }); })
        .catch(() => { if (!controller.signal.aborted) setState({ status: "failed", check: null, key }); });
    }, 700);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key, enabled]);
  // An answer for other data is stale by definition.
  return state.key === key ? state : { status: enabled ? "checking" : "idle", check: state.check, key: state.key };
}
