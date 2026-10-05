import type { ObligationOverview } from "@/lib/supply/obligations";

const money = (value: number | null) => value === null ? "Sin verificar" : `${value.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
export function FinancePanel({ data }: { data: ObligationOverview | null }) {
  return <section aria-labelledby="finance-title" className="mx-auto my-6 max-w-7xl rounded-2xl border border-white/10 bg-zinc-950 p-5">
    <h2 id="finance-title" className="text-lg font-semibold">Respaldo de videos pendientes</h2>
    <p className="mt-2 text-sm text-zinc-400">Estimación conservadora de las cuotas disponibles este mes y los trabajos en curso. Incluye un margen del 30 %.</p>
    {data ? <>
      <p className="my-3 text-sm">Cuentas con acceso: {data.accounts} · En prueba: {data.trials} · Trabajos en curso: {data.processingJobs}</p>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[["Videos sin avatar disponibles", data.remainingReels], ["Avatares disponibles", data.remainingAvatars], ["Costo de cuotas sin usar", money(data.futureUsd)], ["Respaldo de trabajos en curso", money(data.processingUsd)], ["Reserva recomendada con margen", money(data.reserveUsd)], ["Dinero libre para publicidad", "Sin verificar"]].map(([label, value]) => <div key={label} className="rounded-xl border border-white/10 p-3"><dt className="text-sm text-zinc-400">{label}</dt><dd className="mt-1 font-medium">{value}</dd></div>)}
      </dl>
      {data.unmappedPlans > 0 && <p className="mt-3 text-sm text-amber-400" role="status">{data.unmappedPlans} cuentas tienen un plan sin verificar; la reserva total no está certificada.</p>}
      {data.missingRates.length > 0 && <p className="mt-3 text-sm text-amber-400" role="status">Faltan costos de planificación para: {data.missingRates.join(", ")}.</p>}
    </> : <p className="mt-3 text-amber-400" role="status">No se pudieron comprobar las cuotas y reservas pendientes.</p>}
    <p className="mt-3 text-xs text-zinc-400">Las tarifas son estimaciones por modalidad, no facturas. El acceso a videos largos se presupuesta por el modo más costoso disponible. Los cobros pendientes de depósito, gastos fijos, impuestos y saldos por conciliar no se convierten en dinero libre. Este panel no transfiere dinero ni modifica cuotas.</p>
  </section>;
}
