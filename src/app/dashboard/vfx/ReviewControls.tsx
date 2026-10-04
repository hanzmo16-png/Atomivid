"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { checkLabel, type ReviewStage } from "@/lib/production-intelligence/vfx-director/review-view";

export function ReviewControls({ jobId, environmentId, item, materialAvailable }: {
  jobId: string; environmentId?: string; item: ReviewStage; materialAvailable: boolean;
}) {
  const router = useRouter();
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const complete = item.checks.every(name => evidence[name]?.trim());
  async function submit(approved: boolean) {
    if (busy || !complete || !item.sha256) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/admin/vfx-director", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve", id: jobId, environmentId, stage: item.stage,
          planHash: item.planHash, artifactSha256: item.sha256, approved,
          checks: item.checks.map(name => ({ name, pass: approved, evidence: evidence[name].trim() })) }),
      });
      if (!response.ok) throw new Error("La revisión quedó bloqueada. Actualiza para comprobar la versión y sus requisitos.");
      router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo guardar la revisión."); }
    finally { setBusy(false); }
  }
  if (!item.canReject) return null;
  return <details className="mt-3 min-w-0">
    <summary className="cursor-pointer text-sm font-medium">Revisar esta versión</summary>
    <p className="my-2 text-sm text-ink-muted">Registra lo observado en el material correspondiente. Una aprobación requiere evidencia en cada criterio.</p>
    <div className="space-y-2">{item.checks.map(name => <label key={name} className="block min-w-0 text-sm">
      {checkLabel(name)}<textarea value={evidence[name] ?? ""} maxLength={2000} rows={2}
        onChange={event => setEvidence(current => ({ ...current, [name]: event.target.value }))}
        className="mt-1 block w-full max-w-full rounded border border-border bg-canvas p-2" />
    </label>)}</div>
    <div className="mt-3 flex flex-wrap gap-3">
      <button disabled={busy || !complete || !item.canApprove || !materialAvailable} onClick={() => submit(true)} className="w-full rounded border border-border px-3 py-2 disabled:opacity-40 sm:w-auto">Aprobar versión</button>
      <button disabled={busy || !complete} onClick={() => submit(false)} className="w-full rounded border border-border px-3 py-2 disabled:opacity-40 sm:w-auto">Rechazar por defecto</button>
    </div>
    {error && <p role="alert" className="mt-2 text-sm">{error}</p>}
  </details>;
}
