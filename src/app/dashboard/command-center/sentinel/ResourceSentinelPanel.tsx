import type { SentinelCard, SentinelView, Tone } from "@/lib/command-center/sentinel/view";
import type { AqlCard } from "@/lib/command-center/sentinel/aql";
import { SentinelFreshness } from "./SentinelFreshness";

const TEXT: Record<Tone, string> = { ok: "text-emerald-300", warn: "text-amber-300", danger: "text-red-300", muted: "text-zinc-400", info: "text-sky-300" };
const DOT: Record<Tone, string> = { ok: "bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.7)]", warn: "bg-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.7)]", danger: "bg-red-500 shadow-[0_0_12px_rgba(239,68,68,0.8)]", muted: "bg-zinc-500", info: "bg-sky-400" };
const RING: Record<Tone, string> = { ok: "border-emerald-500/30", warn: "border-amber-500/40", danger: "border-red-500/50", muted: "border-white/10", info: "border-sky-500/30" };
const PILL: Record<Tone, string> = { ok: "bg-emerald-500/10 text-emerald-200", warn: "bg-amber-500/10 text-amber-200", danger: "bg-red-500/15 text-red-200", muted: "bg-white/5 text-zinc-300", info: "bg-sky-500/10 text-sky-200" };

function Card({ c }: { c: SentinelCard }) {
  const t = c.light.tone;
  return (
    <li className={`flex flex-col rounded-2xl border ${RING[t]} bg-gradient-to-b from-zinc-900 to-zinc-950 p-4 sm:p-5`} data-testid={`sentinel-card-${c.id}`} data-level={c.light.level}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-white">{c.name}</h3>
          <p className="text-xs text-zinc-400">{c.role}</p>
          {c.sharedBy && <p className="text-[11px] text-sky-300">Una sola billetera para: {c.sharedBy}</p>}
        </div>
        <span className={`inline-flex shrink-0 items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${PILL[t]}`} role="status" aria-label={`Semáforo: ${c.light.label}`}>
          <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${DOT[t]}`} />{c.light.label}
        </span>
      </div>
      <p className="mt-2 text-xs text-zinc-400">{c.light.explanation}</p>

      <div className="mt-4">
        <p className="text-xs uppercase tracking-wide text-zinc-500">Saldo / créditos disponibles{c.balance.status === "ESTIMATED" ? " · estimado" : ""}</p>
        <p className={`mt-1 text-2xl font-semibold tabular-nums ${c.balance.status === "REAL" ? "text-white" : c.balance.status === "ESTIMATED" ? "text-zinc-200" : "text-zinc-400"}`} data-testid="sentinel-balance" data-status={c.balance.status}>{c.balance.display}</p>
        <p className="text-xs text-zinc-500">{c.balance.note}</p>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-xl bg-white/5 p-3"><dt className="text-xs text-zinc-400">Comprometido</dt><dd className="mt-1 font-medium tabular-nums text-zinc-100">{c.committed}</dd></div>
        <div className="rounded-xl bg-white/5 p-3"><dt className="text-xs text-zinc-400">Saldo libre</dt><dd className="mt-1 font-medium tabular-nums text-zinc-100">{c.free}</dd></div>
      </dl>

      <div className="mt-3">
        <p className="text-xs text-zinc-400">Consumo registrado <span className="text-zinc-500">(ledger PI, parcial)</span></p>
        <dl className="mt-1 grid grid-cols-3 gap-2 text-sm">
          {c.consumption.map((x) => <div key={x.label} className="rounded-xl border border-white/5 p-2 text-center"><dt className="text-[11px] text-zinc-500">{x.label}</dt><dd className="mt-0.5 font-medium tabular-nums text-zinc-100">{x.display}</dd></div>)}
        </dl>
      </div>

      <div className="mt-3 flex items-baseline justify-between gap-3 rounded-xl bg-white/5 p-3">
        <div><p className="text-xs text-zinc-400">Autonomía estimada</p><p className="text-[11px] text-zinc-500">{c.autonomy.note}</p></div>
        <p className={`shrink-0 text-lg font-semibold tabular-nums ${TEXT[c.autonomy.tone]}`}>{c.autonomy.display}</p>
      </div>

      {c.alerts.length > 0 && (
        <ul className="mt-3 space-y-1.5" aria-label={`Alertas de ${c.name}`}>
          {c.alerts.map((a, i) => <li key={i} className={`flex gap-2 text-xs ${TEXT[a.tone]}`}><span aria-hidden="true">{a.tone === "danger" ? "▲" : a.tone === "warn" ? "●" : "ℹ"}</span><span>{a.text}</span></li>)}
        </ul>
      )}

      <p className="mt-3 text-[11px] text-zinc-500">{c.limits}</p>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-4">
        <p className="text-[11px] text-zinc-500">Última actualización: <time dateTime={c.updated.iso ?? undefined}>{c.updated.display}</time></p>
        {c.consoleUrl && <a href={c.consoleUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-lg border border-white/15 px-3 text-sm font-medium text-white hover:bg-white/10">Abrir consola de {c.name} <span aria-hidden="true" className="ml-1">↗</span></a>}
      </div>
    </li>
  );
}

function AqlStatus({ a }: { a: AqlCard }) {
  return (
    <div className={`mt-4 rounded-2xl border ${RING[a.tone]} bg-zinc-900/60 p-4`} data-testid="sentinel-aql" data-tone={a.tone}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-white">Bucle de calidad (Mystery Shopper)</p>
        <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${PILL[a.tone]}`} role="status" aria-label={`Bucle de calidad: ${a.label}`}>
          <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${DOT[a.tone]}`} />{a.label}
        </span>
      </div>
      <p className="mt-1 text-xs text-zinc-400">{a.note}</p>
      {a.facts.length > 0 && <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">{a.facts.map((f) => <div key={f.label}><dt className="text-zinc-500">{f.label}</dt><dd className="font-medium text-zinc-100">{f.value}</dd></div>)}</dl>}
      {a.checks && <p className="mt-2 text-xs tabular-nums text-zinc-400">Última evaluación: {a.checks}</p>}
      <a href={a.href} className="mt-3 inline-flex min-h-11 items-center rounded-lg border border-white/15 px-3 text-sm font-medium text-white hover:bg-white/10">Ver el bucle de calidad</a>
    </div>
  );
}

export function ResourceSentinelPanel({ view, aql }: { view: SentinelView; aql?: AqlCard }) {
  return (
    <section aria-labelledby="sentinel-title" className="mx-auto my-6 max-w-7xl rounded-3xl border border-white/10 bg-zinc-950 p-4 sm:p-6" data-testid="resource-sentinel">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-300">Resource Sentinel</p>
          <h2 id="sentinel-title" className="mt-1 text-xl font-semibold text-white">Recursos de proveedores</h2>
          <p className="mt-1 max-w-2xl text-sm text-zinc-400">Saldo, compromisos, consumo y autonomía por proveedor. Solo lectura: este panel no recarga, no reserva ni llama a proveedores de pago. Lo que no se puede verificar aparece como «Desconocido».</p>
        </div>
        <p className="text-xs text-zinc-500">Actualizado: <time dateTime={view.generatedAt || undefined}>{view.generatedDisplay}</time><br />Fuente: {view.source || "—"}</p>
      </div>

      {view.generatedAt && <SentinelFreshness generatedAt={view.generatedAt} />}
      {aql && <AqlStatus a={aql} />}

      {view.counts.length > 0 && (
        <ul className="mt-4 flex flex-wrap gap-2" aria-label="Resumen del semáforo">
          {view.counts.map((c) => <li key={c.level} className={`inline-flex min-h-9 items-center gap-2 rounded-full px-3 text-xs font-medium ${PILL[c.tone]}`}><span aria-hidden="true" className={`h-2 w-2 rounded-full ${DOT[c.tone]}`} />{c.label}: {c.count}</li>)}
        </ul>
      )}
      {view.attention > 0 && <p className="mt-3 text-sm text-amber-300" role="alert">{view.attention} proveedor{view.attention === 1 ? " requiere" : "es requieren"} recarga o revisión.</p>}
      {view.errors.length > 0 && <div className="mt-3 text-xs text-amber-300" role="status" data-testid="sentinel-errors"><p>Limitaciones o errores de esta lectura (los valores afectados aparecen como «Desconocido»):</p><ul className="mt-1 list-disc space-y-0.5 pl-5">{view.errors.map((e) => <li key={e}>{e}</li>)}</ul></div>}

      {view.empty
        ? <p className="mt-4 text-sm text-amber-300" role="status">{view.empty}</p>
        : <ul className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{view.cards.map((c) => <Card key={c.id} c={c} />)}</ul>}
      <p className="mt-4 text-[11px] text-zinc-500">Consumo en USD registrado en el ledger de operaciones pagadas (PI): es parcial, porque Audio y Podcast llevan contabilidad propia, y no sustituye la factura del proveedor. «Hoy» y «Mes» en hora de {view.timezone}; «7 días» son los últimos siete días. Saldo real = lectura de la API de menos de 5 minutos; «≈» = estimado por registro manual. Los saldos van en la unidad de cada proveedor.</p>
    </section>
  );
}
