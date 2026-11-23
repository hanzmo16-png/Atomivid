"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Catalog } from "@/lib/mystery-shopper/catalog";
import { PRODUCT_LABEL, PROFILE_LABEL, PROFILES, type ProductId, type ProfileId, type RunReport, type RunStatus } from "@/lib/mystery-shopper/types";

const STATUS_LABEL: Record<RunStatus, string> = {
  NO_INICIADA: "NO INICIADA",
  EN_PROCESO: "EN PROCESO",
  BLOQUEADA: "BLOQUEADA",
  TERMINADA: "TERMINADA",
  ERROR: "ERROR",
};

export function MysteryShopperPanel({ catalog, sha, environment }: { catalog: Catalog; sha: string; environment: string }) {
  const [product, setProduct] = useState<ProductId>("audio-podcast");
  const [profile, setProfile] = useState<ProfileId>("principiante");
  const [missionId, setMissionId] = useState(catalog.missions[0]?.id ?? "audio-flannan");
  const mission = catalog.missions.find((m) => m.id === missionId) ?? catalog.missions.find((m) => m.product === product) ?? catalog.missions[0];
  const [instructions, setInstructions] = useState(mission?.instructions ?? "");
  const [mode, setMode] = useState<"fixture" | "real">("fixture");
  const [maxBudgetUsd, setMaxBudgetUsd] = useState(0);
  const [status, setStatus] = useState<RunStatus>("NO_INICIADA");
  const [stage, setStage] = useState("Sin empezar");
  const [report, setReport] = useState<RunReport | null>(null);
  const [history, setHistory] = useState<RunReport[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const lock = useRef(false);
  const started = useRef<number | null>(null);

  const missions = useMemo(() => catalog.missions.filter((m) => m.product === product), [catalog.missions, product]);

  useEffect(() => {
    if (!busy) return;
    started.current = Date.now();
    const timer = setInterval(() => { if (started.current) setElapsed(Date.now() - started.current); }, 250);
    return () => clearInterval(timer);
  }, [busy]);

  function chooseProduct(next: ProductId) {
    setProduct(next);
    const first = catalog.missions.find((m) => m.product === next);
    if (first) { setMissionId(first.id); setInstructions(first.instructions); }
  }

  async function start() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setStatus("EN_PROCESO");
    setStage(mode === "real" ? "Comprobando autorización" : "Recorrido gratuito");
    setError(null);
    const idempotencyKey = `panel-${crypto.randomUUID()}`;
    try {
      const res = await fetch("/api/admin/mystery-shopper", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start", mode, product, profile, missionId, instructions, maxBudgetUsd, idempotencyKey, approver: mode === "real" ? "hans" : undefined }),
      });
      const body = await res.json().catch(() => null) as RunReport | { error?: string } | null;
      if (!res.ok || !body || !("status" in body)) {
        setStatus("ERROR");
        setStage("Error");
        setError(body && "error" in body && body.error ? body.error : "No se pudo iniciar la evaluación.");
        return;
      }
      setReport(body);
      setStatus(body.status);
      setStage(body.stage);
      setHistory((prev) => [body, ...prev.filter((item) => item.idempotencyKey !== body.idempotencyKey)]);
      if (body.errors[0]) setError(body.errors[0]);
    } catch {
      setStatus("ERROR");
      setStage("Error");
      setError("No hubo respuesta del panel.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <section id="mystery-shopper" aria-labelledby="mystery-shopper-title" className="min-w-0 rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-faint">Evaluación de cliente</p>
      <h2 id="mystery-shopper-title" className="text-xl font-semibold text-ink">Mystery Shopper AI</h2>
      <p className="mt-1 text-sm text-ink-muted">Recorre un producto como lo haría un cliente y señala lo que se atasca. El modo gratuito no gasta. El modo real permanece bloqueado.</p>

      <div className="mt-4 grid gap-3">
        <label className="text-sm font-medium text-ink" htmlFor="ms-product">Producto</label>
        <select id="ms-product" className="min-h-11 rounded-md border border-border bg-surface px-3" value={product} onChange={(e) => chooseProduct(e.target.value as ProductId)}>
          {(Object.keys(PRODUCT_LABEL) as ProductId[]).filter((id) => catalog.missions.some((m) => m.product === id)).map((id) => <option key={id} value={id}>{PRODUCT_LABEL[id]}</option>)}
        </select>
        <label className="text-sm font-medium text-ink" htmlFor="ms-profile">Perfil</label>
        <select id="ms-profile" className="min-h-11 rounded-md border border-border bg-surface px-3" value={profile} onChange={(e) => setProfile(e.target.value as ProfileId)}>
          {PROFILES.map((id) => <option key={id} value={id}>{PROFILE_LABEL[id]}</option>)}
        </select>
        <label className="text-sm font-medium text-ink" htmlFor="ms-mission">Misión</label>
        <select id="ms-mission" className="min-h-11 rounded-md border border-border bg-surface px-3" value={mission?.id ?? ""} onChange={(e) => { const next = catalog.missions.find((m) => m.id === e.target.value); if (next) { setMissionId(next.id); setInstructions(next.instructions); setProduct(next.product); } }}>
          {missions.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
        </select>
        <label className="text-sm font-medium text-ink" htmlFor="ms-instructions">Instrucciones</label>
        <textarea id="ms-instructions" className="min-h-28 rounded-md border border-border bg-surface px-3 py-2" value={instructions} maxLength={2000} onChange={(e) => setInstructions(e.target.value)} />
        <fieldset className="flex flex-wrap gap-3">
          <legend className="mb-1 text-sm font-medium text-ink">Modo</legend>
          <label className="inline-flex min-h-11 items-center gap-2"><input type="radio" name="ms-mode" checked={mode === "fixture"} onChange={() => setMode("fixture")} /> A · Gratuito (fixture)</label>
          <label className="inline-flex min-h-11 items-center gap-2"><input type="radio" name="ms-mode" checked={mode === "real"} onChange={() => setMode("real")} /> B · Real (bloqueado)</label>
        </fieldset>
        <label className="text-sm font-medium text-ink" htmlFor="ms-budget">Presupuesto máximo (USD)</label>
        <input id="ms-budget" className="min-h-11 rounded-md border border-border bg-surface px-3" type="number" min={0} step="0.01" value={maxBudgetUsd} onChange={(e) => setMaxBudgetUsd(Number(e.target.value))} />
        <p className="text-xs text-ink-faint">Entorno: {environment}. SHA: {sha}. Gasto de esta herramienta: USD 0.</p>
        <button type="button" className="min-h-11 rounded-md bg-accent px-4 font-medium text-accent-ink disabled:opacity-50" onClick={() => void start()} disabled={busy}>Iniciar evaluación</button>
      </div>

      <div className="mt-4 rounded-xl border border-border p-3" role="status" aria-live="polite">
        <p className="text-sm font-semibold text-ink">{STATUS_LABEL[status]}</p>
        <p className="text-sm text-ink-muted">Etapa: {stage}. Tiempo: {Math.round(elapsed / 100) / 10} s.</p>
        {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
      </div>

      {report && <ReportView report={report} />}
      {history.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-ink">Historial de esta visita</h3>
          <ul className="mt-2 space-y-2">
            {history.map((item) => <li key={item.idempotencyKey} className="rounded-lg border border-border px-3 py-2 text-sm">{item.missionId} · {STATUS_LABEL[item.status]} · USD {item.spendUsd.toFixed(2)}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}

function ReportView({ report }: { report: RunReport }) {
  return (
    <div className="mt-4 space-y-3">
      <p className="text-sm text-ink">{report.fixtureLabeled ? "Resultado marcado como FIXTURE." : "Resultado de una sesión en vivo."} Alcance: {report.scope}. Gasto: USD {report.spendUsd.toFixed(2)}.</p>
      {report.liveProbe && <p className="text-sm text-ink-muted">ATOMIVID real: {report.liveProbe.detail}</p>}
      <h3 className="text-sm font-semibold text-ink">Calificación</h3>
      <ul className="space-y-2">
        {report.scores.map((score) => (
          <li key={score.product} className="rounded-lg border border-border px-3 py-2 text-sm">
            <p className="font-medium text-ink">{PRODUCT_LABEL[score.product]}{score.weighted === null ? " · sin promedio" : ` · ${score.weighted}`}</p>
            {score.criticalBlock && <p className="text-danger">Bloqueo crítico: {score.criticalBlock}</p>}
          </li>
        ))}
      </ul>
      <h3 className="text-sm font-semibold text-ink">Clasificación</h3>
      <ul className="space-y-1 text-sm text-ink-muted">
        {report.classifications.map((item) => <li key={item.product}>{PRODUCT_LABEL[item.product]}: {item.availability}. {item.evidence}</li>)}
      </ul>
      {report.findings.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-semibold text-ink">Hallazgos ({report.findings.length})</summary>
          <ul className="mt-2 space-y-3">
            {report.findings.map((finding) => (
              <li key={finding.id} className="rounded-lg border border-border p-3 text-sm">
                <p className="font-medium text-ink">{finding.severity} · {finding.screen} · {PROFILE_LABEL[finding.profile]}</p>
                <p>{finding.problem}</p>
                <p className="mt-1 text-ink-muted">Hecho observado: {finding.fact}</p>
                <p className="text-ink-muted">Interpretación: {finding.interpretation}</p>
                <p className="text-ink-muted">Recomendación: {finding.recommendation}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
      {report.recommendations.length > 0 && <p className="text-sm text-ink-muted">Primera recomendación: {report.recommendations[0]}</p>}
    </div>
  );
}
