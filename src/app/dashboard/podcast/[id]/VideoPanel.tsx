"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { safeParseJsonResponse } from "@/lib/http/safe-json";
import { classifyClientFetchError } from "@/lib/http/client-error";
import type { PodcastVideoStatus } from "@/lib/podcast/episode";
import { minimumBudgetUsd, type VideoChecks } from "@/lib/podcast/pilot";

/**
 * Supervised production of the episode: the owner sets the episode's total budget (what it already spent plus what
 * this production may still cost must fit), produces now or schedules a one-shot
 * start, and can close the app (the worker narrates if needed, renders, and leaves a reviewable delivery or a clear
 * block). The delivery is reviewed here; technical checks never approve it and publication stays held until the
 * owner approves.
 */
export function VideoPanel(props: {
  episodeId: string; status: PodcastVideoStatus; stage: string | null; stalled: boolean; error: string | null;
  canRequest: boolean; playUrl: string | null; downloadUrl: string | null; sizeMb: number | null; minutes: number | null;
  remainingUsd: number; budgetUsd: number | null; scheduledAt: string | null; spentUsd: number | null; seconds: number | null;
  /** Historical spend of the episode from the paid-call ledger (uncertain charges included); null when unreadable. */
  historicalUsd: number | null;
  checks: VideoChecks | null; reviewStatus: "pending" | "approved" | "rejected"; reviewNote: string | null; publishStatus: "held" | "manual";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const minimum = minimumBudgetUsd(props.historicalUsd ?? 0, props.remainingUsd);
  const [budget, setBudget] = useState(String(props.budgetUsd ?? minimum));
  const [when, setWhen] = useState("");
  const [note, setNote] = useState(props.reviewNote ?? "");
  const working = (props.status === "queued" || props.status === "running") && !props.stalled;
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(t);
  }, [working, router]);

  async function post(path: string, body: unknown, ok: string) {
    if (busy) return;
    setBusy(true); setMessage(null);
    try {
      const res = await fetch(`/api/podcast/${props.episodeId}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const out = await safeParseJsonResponse<{ status?: string }>(res);
      if (!out.ok) throw new Error(out.error);
      setMessage({ ok: true, text: ok });
    } catch (e) { setMessage({ ok: false, text: e instanceof Error && e.message ? e.message : classifyClientFetchError(e) }); }
    finally { setBusy(false); router.refresh(); }
  }
  const produce = (schedule: boolean) => post("video", { budgetUsd: budget === "" ? null : Number(budget), scheduleAt: schedule && when ? new Date(when).toISOString() : null },
    schedule ? "Producción programada. Puedes cerrar la app: te avisaremos al entregar o si se detiene." : "Producción iniciada. Puedes cerrar la app: te avisaremos al entregar o si se detiene.");

  const retry = props.status === "failed" || props.status === "blocked" || props.stalled;
  const canStart = props.canRequest && (props.status === "none" || retry || props.status === "ready");
  const fmt = (n: number) => `USD ${n.toFixed(2)}`;
  const fmt4 = (n: number) => `USD ${n.toFixed(4)}`;
  return (
    <Card className="mt-4 p-4 text-sm">
      <h2 className="text-base font-semibold text-ink">Producción supervisada</h2>
      <p className="mt-1 text-ink-muted">Video 16:9 en 1080p con la narración: clips y fotos en movimiento con licencia de Pexels y subtítulos sincronizados. Fija el presupuesto total del episodio: lo ya gastado más lo que esta producción puede costar debe caber; si no alcanza, no empieza y no se cobra nada. La publicación queda detenida hasta que apruebes la entrega.</p>
      {working && <p className="mt-3 text-ink">En producción: {props.stage ?? "en cola"}… Puedes cerrar la app; el avance se guarda.</p>}
      {props.status === "scheduled" && props.scheduledAt && (
        <div className="mt-3 space-y-2">
          <p className="text-ink">Programada para {new Date(props.scheduledAt).toLocaleString("es-MX")} (puede empezar hasta 15–30 min después). Presupuesto total: {props.budgetUsd == null ? "—" : fmt(props.budgetUsd)}.</p>
          <Button variant="secondary" onClick={() => post("video", { cancel: true }, "Programación cancelada. No se cobró nada.")} loading={busy}>Cancelar programación</Button>
        </div>
      )}
      {props.stalled && <p className="mt-3 text-warning">La producción dejó de responder. Puedes reintentarla: la narración y lo ya pagado se conservan.</p>}
      {(props.status === "failed" || props.status === "blocked") && props.error && <p className="mt-3 text-danger">{props.status === "blocked" ? "Detenida: " : ""}{props.error}</p>}

      {canStart && (
        <div className="mt-3 space-y-3">
          <dl className="grid grid-cols-1 gap-1 text-ink-muted sm:grid-cols-3">
            <div><dt className="inline">Ya gastado: </dt><dd className="inline text-ink">{props.historicalUsd == null ? "no disponible" : fmt4(props.historicalUsd)}</dd></div>
            <div><dt className="inline">Pendiente: </dt><dd className="inline text-ink">{props.remainingUsd > 0 ? `hasta ${fmt(props.remainingUsd)} (narración)` : "USD 0 (narración pagada; el video no tiene costo de proveedores)"}</dd></div>
            <div><dt className="inline">Mínimo total: </dt><dd className="inline text-ink">{fmt(minimum)}</dd></div>
          </dl>
          {props.budgetUsd != null && props.budgetUsd + 1e-9 < minimum && <p className="text-warning">El presupuesto total guardado ({fmt(props.budgetUsd)}) no cubre lo ya gastado más lo pendiente: súbelo al menos a {fmt(minimum)}.</p>}
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-ink">Presupuesto total del episodio (USD)</span>
              <input name="budget_usd" type="number" min={0} max={100} step={0.01} inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} className="w-36 rounded-md border border-border bg-surface px-3 py-2 text-base" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-ink">Programar inicio (opcional)</span>
              <input name="schedule_at" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="rounded-md border border-border bg-surface px-3 py-2 text-base" />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => produce(false)} loading={busy}>{props.status === "ready" ? "Volver a producir" : retry ? "Reintentar" : "Producir ahora"}</Button>
            {when && <Button variant="secondary" onClick={() => produce(true)} loading={busy}>Programar</Button>}
          </div>
        </div>
      )}

      {props.status === "ready" && props.playUrl && (
        <section aria-label="Revisión de la entrega" className="mt-4 space-y-3 border-t border-border pt-4">
          <h3 className="text-base font-semibold text-ink">Revisión de la entrega</h3>
          <video controls preload="metadata" playsInline src={props.playUrl} className="aspect-video w-full rounded-lg bg-black" />
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div><dt className="text-ink-muted">Duración</dt><dd className="text-ink">{props.seconds ? `${Math.floor(props.seconds / 60)} min ${Math.round(props.seconds % 60)} s` : "—"}</dd></div>
            <div><dt className="text-ink-muted">Costo total</dt><dd className="text-ink">{fmt4(props.checks?.budget?.spentUsd ?? props.checks?.spend?.spentUsd ?? props.spentUsd ?? 0)}</dd></div>
            <div><dt className="text-ink-muted">Presupuesto total</dt><dd className="text-ink">{props.budgetUsd == null ? "—" : fmt(props.budgetUsd)}</dd></div>
            <div><dt className="text-ink-muted">Tamaño</dt><dd className="text-ink">{props.sizeMb != null ? `${props.sizeMb} MB` : "—"}</dd></div>
          </dl>
          {props.checks ? (
            <>
              <div>
                <h4 className="font-medium text-ink">Comprobaciones técnicas</h4>
                <ul className="mt-1 space-y-1">
                  {props.checks.checks.map((c) => (
                    <li key={c.id} className={c.ok ? "text-ink" : "text-danger"}>{c.ok ? "✓" : "✗"} {c.label}{c.detail ? <span className="text-ink-muted"> — {c.detail}</span> : null}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h4 className="font-medium text-ink">Defectos detectados</h4>
                <ul className="mt-1 space-y-1">
                  {props.checks.defects.map((d) => (
                    <li key={d.id} className={d.severity === "alta" ? "text-danger" : d.severity === "media" ? "text-warning" : "text-ink-muted"}>[{d.severity}] {d.text}</li>
                  ))}
                </ul>
              </div>
            </>
          ) : <p className="text-ink-muted">Esta entrega es anterior a las comprobaciones automáticas.</p>}
          <p className="text-ink-muted">Las comprobaciones confirman la integridad técnica, no la calidad creativa: mira el video completo antes de aprobar.</p>
          {props.downloadUrl && <a href={props.downloadUrl} className="inline-block font-medium text-accent underline">Descargar video{props.sizeMb ? ` (${props.sizeMb} MB)` : ""}</a>}
          {props.minutes ? <p className="text-ink-muted">El enlace dura 6 horas; si caduca, recarga la página.</p> : null}
          <div className="space-y-2">
            <p className="text-ink">Decisión: {props.reviewStatus === "approved" ? "aprobada" : props.reviewStatus === "rejected" ? "rechazada" : "pendiente de tu revisión"}. Publicación: {props.publishStatus === "manual" ? "aprobada para publicar manualmente" : "detenida"}.</p>
            <label className="flex flex-col gap-1">
              <span className="text-ink">Nota (opcional)</span>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} className="rounded-md border border-border bg-surface px-3 py-2 text-base" />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => post("review", { decision: "approve", note }, "Aprobada. Publica descargando el video: la subida automática aún no está disponible.")} loading={busy}>Aprobar para publicar</Button>
              <Button variant="secondary" onClick={() => post("review", { decision: "reject", note }, "Rechazada. La publicación sigue detenida.")} loading={busy}>Rechazar</Button>
            </div>
            <p className="text-ink-muted">Publicación: YouTube está conectado solo en modo lectura (la subida no está habilitada) y Spotify no tiene integración. Tras aprobar, descarga el video y súbelo a mano.</p>
          </div>
        </section>
      )}
      {message && <p className={`mt-2 ${message.ok ? "text-success" : "text-danger"}`}>{message.text}</p>}
    </Card>
  );
}
