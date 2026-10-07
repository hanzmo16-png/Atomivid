import type { SupplyInbox } from "@/lib/command-center/supply-alerts";
import type { WindowKey } from "@/lib/command-center/windows";

const labels = { RED: "Crítico al registrarse", YELLOW: "Saldo bajo al registrarse", UNKNOWN: "Sin verificar al registrarse" };
const colors = { RED: "bg-danger-soft text-danger", YELLOW: "bg-warning-soft text-warning", UNKNOWN: "bg-surface-raised text-ink-muted" };
const dateFormat = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Cancun", dateStyle: "medium", timeStyle: "short", hourCycle: "h23" });

export function SupplyAlertsView({ inbox, window }: { inbox: SupplyInbox; window: WindowKey }) {
  return <section id="credit-alerts" aria-labelledby="credit-alerts-title" className="min-w-0 rounded-2xl border border-border bg-surface/60 p-4 sm:p-5">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="credit-alerts-title" className="text-base font-semibold text-ink">Alertas de créditos</h2>
      <a href={`/dashboard/command-center?window=${window}#credit-alerts`} className="rounded-lg border border-border px-3 py-2 text-sm text-ink">Actualizar panel</a>
    </header>
    <p className="mt-2 text-xs text-ink-muted">Avisos solo dentro del panel. Últimos 20 registros; las fechas se muestran en hora de Cancún.</p>
    <p className="mt-1 text-xs text-ink-faint">Este historial no confirma el saldo actual ni que una alerta siga activa. Actualizar el panel consulta los avisos guardados.</p>
    {!inbox.available ? <p role="status" className="mt-3 rounded-xl bg-warning-soft p-3 text-sm text-warning">No se pudieron consultar los avisos. Intenta actualizar el panel; no asumas que el saldo es suficiente.</p>
      : inbox.alerts.length === 0 ? <p className="mt-3 text-sm text-ink-muted">No hay avisos registrados. Esto no confirma que el monitor esté activo ni que haya saldo suficiente.</p>
      : <ul className="mt-3 space-y-3">{inbox.alerts.map(alert => <li key={alert.id} className="rounded-xl border border-border bg-surface p-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold text-ink">{alert.provider}</h3><span className={`rounded-full px-2.5 py-1 text-xs font-medium ${colors[alert.level]}`}>{labels[alert.level]}</span></div>
        <p className="mt-2 text-sm text-ink">{alert.message}</p>
        <p className="mt-1 text-xs text-ink-muted">{alert.action}</p>
        {alert.createdAt ? <time className="mt-2 block text-xs text-ink-faint" dateTime={alert.createdAt}>{dateFormat.format(new Date(alert.createdAt))}</time> : <p className="mt-2 text-xs text-ink-faint">Fecha no disponible</p>}
      </li>)}</ul>}
  </section>;
}
