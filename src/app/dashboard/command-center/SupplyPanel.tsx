import type { SupplyState } from "@/lib/supply/policy";

const labels = { GREEN: "Disponible", YELLOW: "Reponer pronto", RED: "Atención urgente", UNKNOWN: "Sin verificar" };
const colors = { GREEN: "text-green-400", YELLOW: "text-amber-400", RED: "text-red-400", UNKNOWN: "text-zinc-400" };
export function SupplyPanel({ data }: { data: { states: SupplyState[]; pendingAlerts: number | null; queued: number | null; limits?: { provider: string; dailyUsd: number; monthlyUsd: number; enabled: boolean }[] } | null }) {
  return <section aria-labelledby="supply-title" className="mx-auto my-6 max-w-7xl rounded-2xl border border-white/10 bg-zinc-950 p-5">
    <h2 id="supply-title" className="text-lg font-semibold">Suministro de producción</h2>
    <p className="mt-2 text-sm text-zinc-400">Aviso al 30 % restante o menos de 72 horas de cobertura. Las generaciones requieren recursos y presupuesto verificados.</p>
    <p className="mt-2 text-sm text-zinc-400">Los saldos manuales no caducan: el saldo libre se estima descontando el consumo registrado y las reservas pendientes. Actualízalos al recargar o si gastas fuera de Atomivid. Los topes de gasto siguen activos.</p>
    {data ? <>
      <p className="my-3 text-sm">Avisos registrados: {data.pendingAlerts ?? "Sin verificar"} · Trabajos en espera: {data.queued ?? "Sin verificar"}</p>
      {data.limits && <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="mb-2 text-left">Topes configurados · día de Cancún</caption><thead><tr><th>Proveedor</th><th>Tope diario</th><th>Tope mensual</th><th>Gasto habilitado</th></tr></thead><tbody>{data.limits.map(limit => <tr key={limit.provider}><td>{limit.provider}</td><td>{limit.dailyUsd > 0 ? `${limit.dailyUsd.toFixed(2)} USD` : "Sin definir"}</td><td>{limit.monthlyUsd > 0 ? `${limit.monthlyUsd.toFixed(2)} USD` : "Sin definir"}</td><td>{limit.enabled ? "Sí, sujeto a saldo y controles" : "No"}</td></tr>)}</tbody></table></div>}
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{data.states.map(state => <li key={state.provider} className="rounded-xl border border-white/10 p-3">
        <span className="font-medium">{state.provider}</span> · <span className={colors[state.level]}>{labels[state.level]}</span>
        <p className="mt-1 text-sm text-zinc-400">Saldo libre: {state.free === null || state.free === undefined ? "Sin verificar" : `${state.free.toLocaleString("es-MX", { maximumFractionDigits: 2 })} ${state.unit === "usd" ? "USD" : state.unit === "character" ? "caracteres" : "créditos"}`}</p>
        <p className="text-sm text-zinc-400">Cobertura: {state.coverageHours === null || state.coverageHours === undefined ? "Sin verificar" : `${state.coverageHours.toFixed(1)} horas`}</p>
      </li>)}</ul>
    </> : <p className="mt-3 text-amber-400" role="status">No se pudo verificar el suministro. No se autoriza gasto con datos desconocidos.</p>}
  </section>;
}
