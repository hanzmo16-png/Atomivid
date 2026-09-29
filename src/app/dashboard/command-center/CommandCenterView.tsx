import Link from "next/link";
import type { CommandCenterViewModel, Tile, Tone } from "@/lib/command-center/view-model";
import { WINDOWS, type WindowKey } from "@/lib/command-center/windows";

/**
 * Command Center Visual V1: one mobile-first screen rendered on the server from the
 * view-model. No client state: the time window is a link (?window=…), so it works
 * identically in the browser and in the installed PWA. Nothing here fetches or caches.
 */
const TONE: Record<Tone, string> = {
  ok: "bg-success-soft text-success",
  warn: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  muted: "bg-surface-raised text-ink-muted border border-border",
};
const DOT: Record<Tone, string> = { ok: "bg-success", warn: "bg-warning", danger: "bg-danger", info: "bg-info", muted: "bg-ink-faint" };

function StatePill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${TONE[tone]}`}><span className={`h-1.5 w-1.5 rounded-full ${DOT[tone]}`} aria-hidden />{children}</span>;
}

function MetricTile({ t }: { t: Tile }) {
  const known = t.state === "KNOWN";
  return (
    <div className="flex min-h-[92px] min-w-0 flex-col rounded-xl border border-border bg-surface p-3.5" data-metric={t.id} data-state={t.state}>
      <span className="text-xs font-medium leading-tight text-ink-muted">{t.label}</span>
      {known ? (
        <span className="mt-1.5 truncate text-2xl font-semibold leading-none tracking-tight text-ink tabular-nums">{t.display}</span>
      ) : (
        <span className="mt-1.5 inline-flex"><StatePill tone={t.tone}>{t.display}</StatePill></span>
      )}
      {t.note && <span className="mt-auto line-clamp-2 break-words pt-1.5 text-[11px] leading-snug text-ink-faint">{t.note}</span>}
    </div>
  );
}

function Section({ title, subtitle, children, id }: { title: string; subtitle?: string; children: React.ReactNode; id: string }) {
  return (
    <section id={id} className="min-w-0 scroll-mt-24 rounded-2xl border border-border bg-surface/60 p-4 sm:p-5">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {subtitle && <span className="text-xs text-ink-faint">{subtitle}</span>}
      </header>
      {children}
    </section>
  );
}

function Notice({ tone, title, body }: { tone: Tone; title: string; body?: string }) {
  return (
    <div className={`rounded-xl px-4 py-3 ${TONE[tone]}`} role="status">
      <p className="text-sm font-semibold">{title}</p>
      {body && <p className="mt-0.5 text-xs opacity-90">{body}</p>}
    </div>
  );
}

function CountList({ rows }: { rows: { label: string; count: number }[] }) {
  return (
    <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
      {rows.map((r) => (
        <li key={r.label} className="flex items-center justify-between px-4 py-2.5 text-sm"><span className="text-ink-muted">{r.label}</span><span className="font-semibold tabular-nums text-ink">{r.count}</span></li>
      ))}
    </ul>
  );
}

export function CommandCenterView({ vm }: { vm: CommandCenterViewModel }) {
  const windowLabel: Record<WindowKey, string> = { TODAY: "Today", "7D": "7 days", "28D": "28 days", MTD: "Month", LIFETIME: "Lifetime" };
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-faint">ATOMIVID</p>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Command Center</h1>
        </div>
        <div className="flex flex-col items-start gap-1 sm:items-end" data-overall={vm.overall.status}>
          <StatePill tone={vm.overall.tone}>{vm.overall.status}</StatePill>
          <p className="max-w-xs text-xs text-ink-faint sm:text-right">{vm.overall.reasons[0]}{vm.overall.reasons.length > 1 ? ` · +${vm.overall.reasons.length - 1} more` : ""}</p>
        </div>
      </header>

      <nav aria-label="Time window" className="flex w-full min-w-0 gap-2 overflow-x-auto pb-1">
        {WINDOWS.map((w) => (
          <Link key={w} href={`/dashboard/command-center?window=${w}`} aria-current={w === vm.window ? "page" : undefined} className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-colors ${w === vm.window ? "bg-accent text-accent-ink" : "border border-border bg-surface text-ink-muted hover:text-ink"}`}>{windowLabel[w]}</Link>
        ))}
      </nav>

      <Section id="overview" title="Overview" subtitle={windowLabel[vm.window]}>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">{vm.overview.map((t) => <MetricTile key={t.id} t={t} />)}</div>
      </Section>

      <Section id="production" title="Production">
        {vm.production.types ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div><p className="mb-1.5 text-xs font-medium text-ink-muted">By type</p><CountList rows={vm.production.types} /></div>
            <div><p className="mb-1.5 text-xs font-medium text-ink-muted">By state</p><CountList rows={vm.production.states ?? []} /></div>
          </div>
        ) : (
          <Notice tone="muted" title="Production data unavailable" body="Production analytics require database access." />
        )}
        <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4"><MetricTile t={vm.production.averageProductionTime} /></div>
        <div className="mt-4">
          <p className="mb-1.5 text-xs font-medium text-ink-muted">Final Cut</p>
          {vm.production.finalCut ? <CountList rows={vm.production.finalCut} /> : <Notice tone="muted" title="Final Cut unavailable" body={vm.production.finalCutNote} />}
        </div>
      </Section>

      <Section id="costs" title="Costs" subtitle="COGS = API consumption only">
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">{vm.costs.tiles.map((t) => <MetricTile key={t.id} t={t} />)}<MetricTile t={vm.costs.revenue} /></div>
        {vm.costs.byProvider ? (
          <ul className="mt-3 flex flex-wrap gap-2">{vm.costs.byProvider.map((p) => <li key={p.provider} className="rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-ink-muted">{p.provider} <span className="font-semibold text-ink">{p.display}</span></li>)}</ul>
        ) : (
          <p className="mt-3 text-xs text-ink-faint">Cost by provider: no committed consumption in this window.</p>
        )}
        <p className="mt-2 text-[11px] text-ink-faint">{vm.costs.note}</p>
      </Section>

      <Section id="providers" title="Providers">
        {vm.providers.cards.length ? (
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {vm.providers.cards.map((p) => (
              <div key={p.provider} className={`rounded-xl border p-3.5 ${p.state === "UNKNOWN" ? "border-dashed border-border-strong bg-surface" : "border-border bg-surface"}`} data-provider={p.provider} data-state={p.state}>
                <div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold text-ink">{p.provider}</span><StatePill tone={p.tone}>{p.state}</StatePill></div>
                <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  <div><dt className="text-ink-faint">Availability</dt><dd className="mt-0.5 break-words font-medium text-ink">{p.availability}</dd></div>
                  <div><dt className="text-ink-faint">Balance</dt><dd className={`mt-0.5 font-medium ${p.balance === "Unavailable" ? "text-ink-muted" : "text-ink"}`}>{p.balance}</dd></div>
                  <div><dt className="text-ink-faint">Reserved</dt><dd className="mt-0.5 font-medium text-ink">{p.reserved}</dd></div>
                </dl>
                <p className="mt-2 text-[11px] text-ink-faint">{p.note}</p>
              </div>
            ))}
          </div>
        ) : (
          <Notice tone="muted" title="Provider capacity unavailable" body={vm.providers.unavailableNote ?? undefined} />
        )}
      </Section>

      <Section id="youtube" title="YouTube" subtitle="read-only">
        {vm.youtube.setup === "CONNECTED" ? (
          <>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">{vm.youtube.tiles.map((t) => <MetricTile key={t.id} t={t} />)}</div>
            {vm.youtube.trafficSources && <ul className="mt-3 flex flex-wrap gap-2">{Object.entries(vm.youtube.trafficSources).map(([k, v]) => <li key={k} className="rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-ink-muted">{k} <span className="font-semibold text-ink">{v}</span></li>)}</ul>}
            {vm.youtube.videos.length > 0 && (
              <ul className="mt-3 divide-y divide-border rounded-xl border border-border bg-surface">
                {vm.youtube.videos.map((v) => (
                  <li key={v.videoId} className="flex items-center justify-between gap-3 px-4 py-3 text-sm"><div className="min-w-0"><p className="truncate font-medium text-ink">{v.productionId}</p><p className="truncate text-xs text-ink-faint">{v.videoId}{v.publishedAt ? ` · ${v.publishedAt.slice(0, 10)}` : ""}</p></div><div className="shrink-0 text-right"><p className="font-semibold tabular-nums text-ink">{v.views === null ? "—" : v.views}</p><p className="text-xs text-ink-faint">{v.averagePercentageViewed === null ? "no retention yet" : `${v.averagePercentageViewed}% viewed`}</p></div></li>
                ))}
              </ul>
            )}
            {!vm.youtube.retentionAvailable && <p className="mt-2 text-[11px] text-ink-faint">Audience retention not available yet.</p>}
          </>
        ) : (
          <div className="rounded-xl border border-dashed border-border-strong bg-surface p-4" data-youtube={vm.youtube.setup}>
            <p className="text-sm font-semibold text-ink">{vm.youtube.setup === "MIGRATION_REQUIRED" ? "Migration required" : "Not connected"}</p>
            <p className="mt-1 text-xs text-ink-muted">{vm.youtube.setup === "MIGRATION_REQUIRED" ? "YouTube tables require database migration (0024–0028)." : vm.youtube.setup === "NOT_CONFIGURED" ? "Read-only monitoring ready · Google OAuth configuration required" : "Read-only monitoring ready · Connection required"}</p>
            <p className="mt-2 text-[11px] text-ink-faint">Nothing is published from here. Once connected: channels, videos linked, views, watch time, retention, subscribers.</p>
          </div>
        )}
      </Section>

      <Section id="system-health" title="System health">
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
          {vm.health.map((h) => (
            <li key={h.id} className="flex items-center justify-between gap-3 px-4 py-3" data-health={h.id} data-state={h.state}>
              <div className="min-w-0"><p className="text-sm font-medium text-ink">{h.label}</p><p className="line-clamp-2 text-xs text-ink-faint">{h.detail}</p></div>
              <StatePill tone={h.tone}>{h.state}</StatePill>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-ink-faint">Generated {vm.generatedAt.replace("T", " ").slice(0, 16)} UTC · never cached · read-only</p>
      </Section>
    </div>
  );
}
