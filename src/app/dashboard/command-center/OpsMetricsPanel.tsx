import type { CapWindow, DataSource, OpsMetrics, ProjectCost } from "@/lib/ops-panel/metrics";

/**
 * M5 · Panel operativo y financiero — solo presentación. Recibe métricas ya agregadas por
 * computeOpsMetrics (puras) y nunca consulta datos. Cada vista muestra su fuente con una insignia
 * explícita: SINTÉTICO (datos de ejemplo) o datos reales. No está conectado a la página del
 * Command Center: leer datos reales requiere una autorización aparte (docs/ops/panel/EVALUACION.md).
 */
const usd = (v: string) => `${v} USD`;

export function DataSourceBadge({ source }: { source: DataSource }) {
  const synthetic = source.kind === "synthetic";
  return <p data-source={source.kind} role="note" className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${synthetic ? "bg-amber-500/15 text-amber-300" : "bg-sky-500/15 text-sky-300"}`}>
    {synthetic ? "SINTÉTICO · datos de ejemplo, no son cifras reales" : "Datos reales"}
    <span className="font-normal opacity-80">· {source.label} · corte {source.asOf.replace("T", " ").slice(0, 16)} UTC</span>
  </p>;
}

function Card({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="rounded-xl border border-white/10 p-3"><dt className="text-sm text-zinc-400">{label}</dt><dd className="mt-1 font-medium tabular-nums">{value}</dd>{note && <p className="mt-1 text-xs text-zinc-500">{note}</p>}</div>;
}

function capCell(w: CapWindow) {
  if (w.capUsd === null) return "Sin definir";
  return `${usd(w.usedUsd)} de ${usd(w.capUsd)} (${w.usedPct} %) · ${w.exceeded ? "excedido" : `holgura ${usd(w.headroomUsd!)}`}`;
}

function marginCell(m: ProjectCost["margin"]) {
  if (m.state === "NO_PRICE_SOURCE") return "Sin fuente de precio";
  if (m.state === "UNCERTAIN") return `Incierto (precio ${usd(m.priceUsd)}, ${m.basis}; hay gasto sin conciliar)`;
  return `${usd(m.marginUsd)} (${m.marginPct} %) · precio ${usd(m.priceUsd)}, ${m.basis}`;
}

export function OpsMetricsPanel({ metrics, error }: { metrics: OpsMetrics | null; error?: string | null }) {
  return <section aria-labelledby="ops-title" data-ops-panel="m5" className="mx-auto my-6 max-w-7xl rounded-2xl border border-white/10 bg-zinc-950 p-5">
    <h2 id="ops-title" className="text-lg font-semibold">Panel operativo y financiero</h2>
    {metrics && <div className="mt-2"><DataSourceBadge source={metrics.source} /></div>}
    <p className="mt-2 text-sm text-zinc-400">El gasto confirmado solo incluye operaciones COMMITTED. Lo enviado al proveedor sin conciliar se muestra aparte como gasto incierto. Lo RESERVED no es gasto: no hubo llamada al proveedor.</p>
    {error || !metrics ? <p className="mt-3 text-amber-400" role="status">No se pudieron calcular las métricas{error ? `: ${error}` : ""}. No se muestran cifras parciales.</p>
      : metrics.totals.ops === 0 ? <p className="mt-3 text-zinc-400" role="status">Sin operaciones registradas en el periodo. Esto es un cero de la fuente indicada, no un dato desconocido.</p>
      : <OpsBody m={metrics} />}
  </section>;
}

function OpsBody({ m }: { m: OpsMetrics }) {
  const t = m.totals;
  return <>
    <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Card label="Gasto confirmado" value={usd(t.committedUsd)} note={`${t.committedOps} operaciones${t.committedWithoutAmount ? ` · ${t.committedWithoutAmount} sin importe final (se usa la reserva)` : ""}`} />
      <Card label="Gasto incierto (sin conciliar)" value={usd(t.uncertainUsd)} note={`${t.uncertainOps} operaciones${t.unknownStatusOps ? ` · ${t.unknownStatusOps} con estado desconocido` : ""}`} />
      <Card label="Reservado sin gastar" value={usd(t.reservedNotSpentUsd)} note={`${t.reservedOps} reservas · ${t.releasedOps} reembolsos conciliados · ${t.excludedOps} retenciones de capacidad excluidas`} />
    </dl>

    <h3 className="mt-5 text-sm font-semibold">Actividad y errores</h3>
    <dl className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card label="Llamadas activas al proveedor" value={String(m.activity.activeProviderCalls)} />
      <Card label="Requieren conciliación" value={String(m.activity.reconciliationRequired)} />
      <Card label="Reembolsos sin conciliar" value={String(m.activity.refundsUnreconciled)} />
      {m.activity.jobs.state === "KNOWN"
        ? <Card label="Trabajos" value={`${m.activity.jobs.running} en curso · ${m.activity.jobs.queued} en espera · ${m.activity.jobs.failed} fallidos`} note={`${m.activity.jobs.completed} completados · ${m.activity.jobs.other} otros`} />
        : <Card label="Trabajos" value="Sin fuente de trabajos" />}
    </dl>

    <div className="mt-5 overflow-x-auto"><table className="w-full text-left text-sm"><caption className="mb-2 text-left font-semibold">Gasto por proveedor</caption>
      <thead><tr><th>Proveedor</th><th>Confirmado</th><th>Incierto</th><th>Operaciones</th></tr></thead>
      <tbody>{m.byProvider.map(p => <tr key={p.provider}><td>{p.provider}</td><td>{usd(p.committedUsd)}</td><td>{usd(p.uncertainUsd)}</td><td>{p.ops}</td></tr>)}</tbody></table></div>

    <div className="mt-5 overflow-x-auto"><table className="w-full text-left text-sm"><caption className="mb-2 text-left font-semibold">Gasto por día</caption>
      <thead><tr><th>Día</th><th>Confirmado</th><th>Incierto</th></tr></thead>
      <tbody>{m.byDay.map(d => <tr key={d.day}><td>{d.day}</td><td>{usd(d.committedUsd)}</td><td>{usd(d.uncertainUsd)}</td></tr>)}</tbody></table></div>

    <div className="mt-5 overflow-x-auto"><table className="w-full text-left text-sm"><caption className="mb-2 text-left font-semibold">Costo por video</caption>
      <thead><tr><th>Proyecto</th><th>Confirmado</th><th>Incierto</th><th>Tope y holgura</th><th>Margen</th></tr></thead>
      <tbody>{m.byProject.map(p => <tr key={p.projectId} data-complete={p.complete}><td>{p.projectId}</td><td>{usd(p.committedUsd)}</td><td>{usd(p.uncertainUsd)}{p.complete ? "" : " · costo final pendiente"}</td>
        <td>{p.cap ? `${usd(p.cap.capUsd)} (${p.cap.kind}) · ${p.cap.exceeded ? `excedido por ${usd(p.cap.headroomUsd.replace("-", ""))}` : `holgura ${usd(p.cap.headroomUsd)}`}` : "Sin tope registrado"}</td>
        <td>{marginCell(p.margin)}</td></tr>)}</tbody></table></div>
    {m.margins.state === "NO_PRICE_SOURCE" && <p className="mt-2 text-sm text-amber-400" role="status">Margen: sin fuente de precio. No se estima un margen sin un precio verificable por video.</p>}
    {m.margins.state === "PARTIAL" && <p className="mt-2 text-sm text-amber-400" role="status">Margen parcial: {m.margins.unpriced} videos sin fuente de precio.</p>}

    <h3 className="mt-5 text-sm font-semibold">Topes y holgura por proveedor</h3>
    {m.headroom.state === "KNOWN"
      ? <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>Proveedor</th><th>Hoy</th><th>Mes</th><th>Gasto habilitado</th></tr></thead>
        <tbody>{m.headroom.providers.map(p => <tr key={p.provider} data-exceeded={p.daily.exceeded || p.monthly.exceeded}><td>{p.provider}</td><td>{capCell(p.daily)}</td><td>{capCell(p.monthly)}</td><td>{p.enabled ? "Sí" : "No"}</td></tr>)}</tbody></table></div>
      : <p className="mt-2 text-sm text-zinc-400" role="status">Sin fuente de topes.</p>}
    <p className="mt-3 text-xs text-zinc-400">El consumo contra topes usa el mayor entre reserva y costo final de toda operación enviada, igual que el control de gasto. Los importes se calculan con 4 decimales exactos.</p>
  </>;
}
