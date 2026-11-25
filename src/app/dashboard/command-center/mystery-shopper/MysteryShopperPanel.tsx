"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Catalog } from "@/lib/mystery-shopper/catalog";
import type { JobState, JobView } from "@/lib/mystery-shopper/jobs";
import type { LiveReport } from "@/lib/mystery-shopper/live";
import { CertificationMatrix } from "./CertificationMatrix";
import { PRODUCT_LABEL, PROFILE_LABEL, PROFILES, type ProductId, type ProfileId } from "@/lib/mystery-shopper/types";

const STATE_LABEL: Record<JobState, string> = {
  en_cola: "En cola: esperando al navegador",
  en_proceso: "Recorriendo ATOMIVID",
  terminada: "Terminada",
  bloqueada: "Bloqueada: necesita algo de una persona",
  error: "Error",
};
const VERDICT_LABEL: Record<string, string> = { FUNCIONA: "Funciona", CON_PROBLEMAS: "Funciona con problemas", BLOQUEADO: "Bloqueado", NO_EVALUADO: "No evaluado" };
const POLL_MS = 4000;

type Detail = { view: JobView; report: LiveReport | null; evidence: { name: string; url: string | null }[] };

function newId(): string {
  const t = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "z").toLowerCase();
  const r = Array.from(crypto.getRandomValues(new Uint8Array(5))).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `ms-${t}-${r}`;
}

/**
 * Cliente misterioso — panel simple. Un botón principal; producto, misión, modo, presupuesto y estado a la vista; lo
 * demás plegado. Cada clic crea UNA evaluación con un id fijado antes de enviar (un doble clic reutiliza el mismo id y
 * el servidor no crea otra). El resultado sale del worker real; aquí no se inventa ni se reutiliza un recorrido.
 */
export function MysteryShopperPanel({ catalog, sha, environment }: { catalog: Catalog; sha: string; environment: string }) {
  const live = useMemo(() => catalog.missions.filter((m) => (m.criteria?.length ?? 0) > 0), [catalog.missions]);
  const [missionId, setMissionId] = useState(live[0]?.id ?? "");
  const [profile, setProfile] = useState<ProfileId>("principiante");
  const mission = live.find((m) => m.id === missionId) ?? live[0];
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [current, setCurrent] = useState<Detail | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const pendingId = useRef<string | null>(null);

  const loadList = useCallback(async () => {
    const r = await fetch("/api/admin/mystery-shopper", { cache: "no-store" }).catch(() => null);
    const b = r && r.ok ? await r.json().catch(() => null) as { jobs: JobView[] } | null : null;
    if (b) setJobs(b.jobs);
  }, []);
  const loadOne = useCallback(async (id: string) => {
    const r = await fetch(`/api/admin/mystery-shopper?id=${encodeURIComponent(id)}`, { cache: "no-store" }).catch(() => null);
    const b = r && r.ok ? await r.json().catch(() => null) as Detail | null : null;
    if (b) setCurrent(b);
  }, []);
  // Primera carga en una tarea aparte (no dentro del cuerpo del efecto).
  useEffect(() => { const t = setTimeout(() => { void loadList(); }, 0); return () => clearTimeout(t); }, [loadList]);
  const running = !!current && (current.view.status.state === "en_cola" || current.view.status.state === "en_proceso");
  const runningRef = useRef(false);
  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => {
    if (!current || !running) return;
    const t = setInterval(() => { void loadOne(current.view.job.id); void loadList(); }, POLL_MS);
    return () => clearInterval(t);
  }, [current, running, loadOne, loadList]);

  async function start(again?: JobView) {
    if (lock.current) return;
    // Con una evaluación en cola o en curso, el botón principal no crea otra (un segundo toque llega tarde a veces).
    if (!again && runningRef.current) { setMessage("Ya hay una evaluación en curso: se muestra abajo. Para otra, usa «Repetir»."); return; }
    lock.current = true; setBusy(true); setError(null); setMessage(null);
    // El id se fija ANTES de enviar: si la respuesta se pierde y se reintenta, es la misma evaluación.
    const id = pendingId.current ?? newId();
    pendingId.current = id;
    try {
      const res = await fetch("/api/admin/mystery-shopper", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, missionId: again?.job.missionId ?? mission?.id, profile: again?.job.profile ?? profile, mode: "gratuito" }),
      });
      const b = await res.json().catch(() => null) as { view?: JobView; message?: string; error?: string } | null;
      if (!res.ok || !b?.view) { setError(b?.error ?? "No se pudo iniciar la evaluación."); return; }
      pendingId.current = null;
      setMessage(b.message ?? null);
      runningRef.current = b.view.status.state === "en_cola" || b.view.status.state === "en_proceso";
      setCurrent({ view: b.view, report: null, evidence: [] });
      void loadList();
    } catch {
      setError("No hubo respuesta. Vuelve a pulsar: se reutiliza la misma evaluación, no se crea otra.");
    } finally {
      lock.current = false; setBusy(false);
    }
  }

  const latestByProduct = useMemo(() => {
    const m = new Map<ProductId, JobView>();
    for (const j of jobs) if (!m.has(j.job.product) && j.status.result) m.set(j.job.product, j);
    return m;
  }, [jobs]);

  return (
    <section id="mystery-shopper" aria-labelledby="mystery-shopper-title" className="min-w-0 rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <h2 id="mystery-shopper-title" className="text-xl font-semibold text-ink">Cliente misterioso</h2>
      <p className="mt-1 text-sm text-ink-muted">Un navegador nuevo entra a ATOMIVID como un cliente, recorre la misión y te dice qué funcionó, qué falló y qué simplificar.</p>

      <button type="button" data-testid="ms-probar" onClick={() => void start()} disabled={busy || running}
        className="mt-4 min-h-14 w-full rounded-xl bg-accent px-4 text-lg font-semibold text-accent-ink disabled:opacity-60">
        {busy ? "Iniciando…" : running ? "Evaluación en curso…" : "PROBAR MI PLATAFORMA"}
      </button>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm" data-testid="ms-resumen">
        <dt className="text-ink-faint">Producto</dt><dd className="min-w-0 text-ink">{mission ? PRODUCT_LABEL[mission.product] : "—"}</dd>
        <dt className="text-ink-faint">Misión</dt><dd className="min-w-0 text-ink">{mission?.title ?? "—"}</dd>
        <dt className="text-ink-faint">Modo</dt><dd className="text-ink">Gratuito: navega sin generar nada que cueste</dd>
        <dt className="text-ink-faint">Presupuesto autorizado</dt><dd className="text-ink">USD 0</dd>
        <dt className="text-ink-faint">Estado</dt><dd className="text-ink" role="status" aria-live="polite" data-testid="ms-estado">{current ? STATE_LABEL[current.view.status.state] : "Sin evaluaciones en curso"}</dd>
      </dl>
      {message && <p className="mt-2 text-sm text-ink-muted">{message}</p>}
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}

      <details className="mt-3 rounded-lg border border-border p-3">
        <summary className="min-h-11 cursor-pointer content-center text-sm font-medium text-ink">Cambiar producto, misión o perfil</summary>
        <div className="mt-2 grid gap-2">
          <label className="text-sm font-medium text-ink" htmlFor="ms-mission">Misión</label>
          <select id="ms-mission" className="min-h-11 min-w-0 rounded-md border border-border bg-surface px-3" value={mission?.id ?? ""} onChange={(e) => setMissionId(e.target.value)}>
            {live.map((m) => <option key={m.id} value={m.id}>{PRODUCT_LABEL[m.product]} — {m.title}</option>)}
          </select>
          <label className="text-sm font-medium text-ink" htmlFor="ms-profile">Tipo de cliente</label>
          <select id="ms-profile" className="min-h-11 min-w-0 rounded-md border border-border bg-surface px-3" value={profile} onChange={(e) => setProfile(e.target.value as ProfileId)}>
            {PROFILES.map((id) => <option key={id} value={id}>{PROFILE_LABEL[id]}</option>)}
          </select>
          {mission && <p className="text-xs text-ink-muted">Éxito si: {(mission.criteria ?? []).join(" · ")}</p>}
          <p className="text-xs text-ink-faint">Modo real (con generación pagada): bloqueado hasta que Hans apruebe un presupuesto. Versión {sha.slice(0, 7)} · {environment}.</p>
        </div>
      </details>

      {current && <CurrentRun detail={current} onOpen={() => void loadOne(current.view.job.id)} />}

      <h3 className="mt-5 text-sm font-semibold text-ink">Estado por producto (última evaluación real)</h3>
      <ul className="mt-2 grid gap-2 sm:grid-cols-2" data-testid="ms-productos">
        {(Object.keys(PRODUCT_LABEL) as ProductId[]).map((p) => {
          const j = latestByProduct.get(p);
          const r = j?.status.result;
          return (
            <li key={p} className="min-w-0 rounded-lg border border-border px-3 py-2 text-sm">
              <p className="font-medium text-ink">{PRODUCT_LABEL[p]}</p>
              <p className="text-ink-muted">{r ? `${VERDICT_LABEL[r.verdict] ?? r.verdict}${r.score !== null ? ` · ${r.score}/100` : ""}${r.critical ? ` · ${r.critical}` : ""}` : "Aún sin evaluación real"}</p>
            </li>
          );
        })}
      </ul>

      <CertificationMatrix jobs={jobs} />

      <h3 className="mt-5 text-sm font-semibold text-ink">Historial</h3>
      {jobs.length === 0 ? <p className="mt-1 text-sm text-ink-muted">Todavía no hay evaluaciones guardadas.</p> : (
        <ul className="mt-2 space-y-2" data-testid="ms-historial">
          {jobs.map((j) => (
            <li key={j.job.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm">
              <button type="button" className="min-h-11 min-w-0 flex-1 text-left" onClick={() => void loadOne(j.job.id)}>
                <span className="block truncate font-medium text-ink">{PRODUCT_LABEL[j.job.product]} · {new Date(j.job.requestedAt).toLocaleString("es-MX")}</span>
                <span className="block text-ink-muted">{STATE_LABEL[j.status.state]}{j.status.result ? ` · ${VERDICT_LABEL[j.status.result.verdict] ?? j.status.result.verdict}` : ""}{j.job.source === "ci" ? " · automática" : ""}</span>
              </button>
              <button type="button" className="min-h-11 rounded-md border border-border px-3" onClick={() => void start(j)} disabled={busy}>Repetir</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CurrentRun({ detail, onOpen }: { detail: Detail; onOpen: () => void }) {
  const { view, report, evidence } = detail;
  const s = view.status;
  return (
    <div className="mt-4 rounded-xl border border-border p-3" data-testid="ms-actual">
      <p className="text-sm font-semibold text-ink">{STATE_LABEL[s.state]}</p>
      <p className="text-sm text-ink-muted">{s.stage}{s.browser ? ` · navegador nuevo ${s.browser.version}` : ""}</p>
      {s.result?.humanGate && <p className="mt-1 text-sm text-danger">Necesita: {s.result.humanGate}</p>}
      {!report && view.hasReport && <button type="button" className="mt-2 min-h-11 rounded-md border border-border px-3 text-sm" onClick={onOpen}>Ver resultado</button>}
      {report && (
        <div className="mt-3 space-y-3 text-sm" data-testid="ms-informe">
          <p className="text-ink">{report.plain.doing}</p>
          <p className="font-medium text-ink">Resultado: {VERDICT_LABEL[report.verdict.verdict]}{report.verdict.score !== null ? ` · ${report.verdict.score}/100` : " · sin nota (no se pudo comprobar todo)"}</p>
          {report.verdict.criticalBlock && <p className="text-danger">Bloqueo: {report.verdict.criticalBlock}</p>}
          <p className="text-ink-muted">Qué encontró: {report.plain.found}</p>
          {report.plain.worked.length > 0 && <div><p className="font-medium text-ink">Funcionó</p><ul className="list-disc pl-5 text-ink-muted">{report.plain.worked.map((w) => <li key={w}>{w}</li>)}</ul></div>}
          {report.plain.failed.length > 0 && <div><p className="font-medium text-ink">Falló</p><ul className="list-disc pl-5 text-ink-muted">{report.plain.failed.map((w) => <li key={w}>{w}</li>)}</ul></div>}
          {report.plain.simplify.length > 0 && <div><p className="font-medium text-ink">Qué simplificar</p><ul className="list-disc pl-5 text-ink-muted">{report.plain.simplify.map((w) => <li key={w}>{w}</li>)}</ul></div>}
          {report.plain.needsAuthorization.length > 0 && <div><p className="font-medium text-ink">Necesita autorización</p><ul className="list-disc pl-5 text-ink-muted">{report.plain.needsAuthorization.map((w) => <li key={w}>{w}</li>)}</ul></div>}
          <details>
            <summary className="min-h-11 cursor-pointer content-center font-medium text-ink">Detalle: pasos, hallazgos y evidencias</summary>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-ink-muted">{report.steps.map((st) => <li key={st.n}>{st.state} · {st.name} — {st.detail}</li>)}</ol>
            {report.findings.map((f, i) => (
              <div key={i} className="mt-2 rounded-lg border border-border p-2">
                <p className="font-medium text-ink">{f.severity} · {f.screen}</p>
                <p><b>Hecho:</b> {f.fact}</p><p><b>Interpretación:</b> {f.interpretation}</p><p><b>Recomendación:</b> {f.recommendation}</p>
              </div>
            ))}
            <ul className="mt-2 space-y-1">{evidence.map((e) => <li key={e.name}>{e.url ? <a className="text-accent underline" href={e.url} target="_blank" rel="noreferrer">{e.name}</a> : e.name}</li>)}</ul>
            <p className="mt-2 text-xs text-ink-faint">Sesión {report.browser.sessionId} · {report.browser.viewport.width}×{report.browser.viewport.height} · {report.target.url} · SHA observado {report.observedSha ?? "no informado"} · gasto USD {report.spendUsd.toFixed(2)}</p>
          </details>
        </div>
      )}
    </div>
  );
}
