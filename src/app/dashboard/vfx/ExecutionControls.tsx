"use client";
import { GenerationProgress } from "@/components/ui/GenerationProgress";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ExecutionView } from "@/lib/production-intelligence/vfx-director/execution";

const time = (iso: string | null) => iso ? new Date(iso).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" }) : "—";

/** Sends only the job identity and the exact version shown. The server decides everything else. */
export function ExecutionControls({ jobId, revision, planHash, view }: { jobId: string; revision: number; planHash: string; view: ExecutionView }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  // While a run is registered, keep the status current without asking for anything else.
  useEffect(() => {
    if (!view.active) return;
    const timer = setInterval(() => router.refresh(), 10_000);
    return () => clearInterval(timer);
  }, [view.active, router]);
  async function post(body: Record<string, unknown>, done: string) {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/admin/vfx-director", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === "string" && data.error !== "VFX operation blocked" ? data.error : "La acción quedó bloqueada. Actualiza para comprobar el estado.");
      setMessage(data.status === "RECONCILIATION_REQUIRED" ? "No se pudo confirmar el envío al worker. No se reintentará solo: revisa el estado antes de volver a ejecutar."
        : data.status === "REFUNDED" ? "GitHub rechazó el envío; no se ejecutó nada." : done);
      router.refresh();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "No se pudo completar la acción."); }
    finally { setBusy(false); }
  }
  const label = view.mode === "reconcile" ? "Conciliar tarea interrumpida" : "Ejecutar siguiente tarea";
  return <div className="mt-3 min-w-0 space-y-3 text-sm">
    <p>{view.pendingTask ? <>{view.mode === "reconcile" ? "Tarea interrumpida" : "Siguiente tarea"}: <strong>{view.pendingTask}</strong></> : "No hay tareas pendientes de ejecución."}</p>
    {view.reason && <p className="text-ink-muted">{view.reason}</p>}
    <button type="button" disabled={busy || !view.canDispatch} onClick={() => {
      if (view.mode && window.confirm(`${label}: ${view.pendingTask}. Se registrará antes de enviarse al worker y no se repetirá automáticamente.`)) post({ action: "execute", id: jobId, mode: view.mode, revision, planHash }, "Ejecución registrada y enviada al worker. Esta página se actualizará sola.");
    }} className="w-full rounded border border-border px-3 py-2 disabled:opacity-40 sm:w-auto">{busy ? "Enviando…" : label}</button>
    {busy && <GenerationProgress label="Enviando solicitud VFX" />}
    {message && <p role="status" className="break-words">{message}</p>}
    {view.dispatches.length > 0 && <div className="space-y-2">
      <h3 className="font-medium">Ejecuciones recientes</h3>
      <ul className="space-y-2">{view.dispatches.map(d => <li key={d.key} className="min-w-0 rounded border border-border p-2">
        <p className="break-words"><strong>{d.label}</strong>{d.outcome ? ` · ${d.outcome}` : ""}</p>
        <p className="text-ink-muted">{d.task ?? "Sin tarea"} · {d.mode === "reconcile" ? "Conciliación" : "Ejecución"} · solicitada {time(d.requestedAt)}</p>
        {d.resolvable && <button type="button" disabled={busy} onClick={() => {
          if (window.confirm("Se comprobará con GitHub que esta ejecución ya no está en cola ni en curso y se cerrará sin repetirla. ¿Continuar?")) post({ action: "resolve-dispatch", id: jobId, key: d.key }, "Ejecución cerrada. Puedes volver a ejecutar cuando quieras.");
        }} className="mt-2 w-full rounded border border-border px-3 py-1 disabled:opacity-40 sm:w-auto">Cerrar ejecución interrumpida</button>}
        <details className="mt-1 text-ink-muted"><summary className="cursor-pointer">Detalles de auditoría</summary>
          <p className="break-all">Registro: {d.key}</p><p>Estado técnico: {d.status}{d.code ? ` · ${d.code}` : ""}</p>
          {d.runId && <p className="break-all">Ejecución de GitHub: {d.runId}</p>}<p>Actualizado: {time(d.updatedAt)}</p>
        </details>
      </li>)}</ul>
    </div>}
  </div>;
}
