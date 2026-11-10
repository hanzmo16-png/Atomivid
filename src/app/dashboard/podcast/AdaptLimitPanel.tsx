"use client";

/**
 * «Adaptar producción al límite disponible» (incidente 4290175a): la persona ve qué cambia, qué se conserva y el costo
 * ANTES de confirmar; al confirmar se reintenta el MISMO episodio (sin duplicar cobros ni trabajos). Sin red en el render:
 * las pruebas usan `AdaptProposalView` con una propuesta fija.
 */
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { safeParseJsonResponse } from "@/lib/http/safe-json";
import type { AdaptProposal } from "@/lib/podcast/v3/adapt";
import { isAvatarQuotaError } from "@/lib/podcast/library";

/** ¿El error del episodio es el límite diario de llamadas del avatar? Una sola regla, compartida con la biblioteca. */
export { isAvatarQuotaError };

/** Por qué no se puede confirmar (o null si se puede). */
export function confirmBlocker(p: AdaptProposal): string | null {
  if (!p.quality.ok) return `No se aplica: ${p.quality.issues.join(" ")}`;
  if (!p.withinBudget) return `Con el ajuste el costo estimado supera tu tope (USD ${p.budgetUsd.toFixed(2)}).`;
  if (!p.readyAfter) return `Aun con el ajuste no se puede iniciar: ${p.blockAfter ?? "un proveedor no está disponible."} Tu episodio se conserva.`;
  return null;
}

export function AdaptProposalView({ id, proposal, summary, busy, onConfirm, onCancel }: {
  id: string; proposal: AdaptProposal; summary: string[]; busy?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  const blocker = confirmBlocker(proposal);
  return (
    <div className="mt-2 grid gap-2 rounded border border-border p-2 text-xs text-ink" data-testid={`adaptar-propuesta-${id}`}>
      <p className="font-semibold">Esto es lo que se ajustará (todavía no se ha cambiado nada):</p>
      <ul className="list-disc pl-4" data-testid={`adaptar-resumen-${id}`}>{summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
      {blocker && <p role="alert" className="text-danger" data-testid={`adaptar-bloqueo-${id}`}>{blocker}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" loading={busy} disabled={!!blocker} onClick={onConfirm} data-testid={`adaptar-confirmar-${id}`}>Confirmar y reintentar este episodio</Button>
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onCancel} data-testid={`adaptar-cancelar-${id}`}>Cancelar</Button>
      </div>
    </div>
  );
}

export function AdaptLimitPanel({ episodeId, onStarted }: { episodeId: string; onStarted?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [view, setView] = useState<{ proposal: AdaptProposal; summary: string[] } | null>(null);
  async function call(body: Record<string, unknown>) {
    const res = await fetch(`/api/podcast/v3/${episodeId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "adaptar", ...body }) });
    return safeParseJsonResponse<{ proposal?: AdaptProposal; summary?: string[]; fits?: boolean; message?: string; ok?: boolean; dispatched?: boolean; note?: string | null }>(res);
  }
  async function preview() {
    if (busy) return;
    setBusy(true); setNote(null);
    try {
      const out = await call({ preview: true });
      if (!out.ok) { setNote(out.error); return; }
      if (out.data.fits) { setNote(out.data.message ?? "Tu episodio ya cabe en el límite disponible."); return; }
      if (out.data.proposal && out.data.summary) setView({ proposal: out.data.proposal, summary: out.data.summary });
    } catch { setNote("No se pudo calcular la propuesta. Inténtalo de nuevo."); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (busy || !view) return;
    setBusy(true); setNote(null);
    try {
      const out = await call({ confirm: true, maxCalls: view.proposal.maxCalls });
      if (!out.ok) {
        const b = (out.body ?? {}) as { proposal?: AdaptProposal; summary?: string[] };
        // La disponibilidad cambió: se muestra la propuesta nueva para revisarla otra vez (nada se aplicó).
        if (b.proposal && b.summary) setView({ proposal: b.proposal, summary: b.summary });
        setNote(out.error); return;
      }
      setView(null);
      setNote(out.data.note ?? "Producción adaptada: el episodio se está generando de nuevo. Lo ya pagado se reutiliza; no se cobra dos veces.");
      onStarted?.();
    } catch { setNote("No se pudo confirmar. Tu episodio se conserva; inténtalo de nuevo."); }
    finally { setBusy(false); }
  }
  return (
    <div className="mt-2" data-testid={`adaptar-${episodeId}`}>
      {!view && <Button type="button" size="sm" variant="secondary" loading={busy} onClick={() => void preview()} data-testid={`adaptar-abrir-${episodeId}`}>Adaptar producción al límite disponible</Button>}
      {!view && <p className="mt-1 text-xs text-ink-muted">Sustituye algunas apariciones del avatar por ilustraciones del mismo momento, sin cambiar el guion ni la duración. Verás el cambio y el costo antes de confirmar.</p>}
      {view && <AdaptProposalView id={episodeId} proposal={view.proposal} summary={view.summary} busy={busy} onConfirm={() => void confirm()} onCancel={() => { setView(null); setNote(null); }} />}
      {note && <p className="mt-1 text-xs text-ink" role="status" data-testid={`adaptar-nota-${episodeId}`}>{note}</p>}
    </div>
  );
}
