/**
 * Command Center view-model: PURE mapping from the service's overview data to what the screen
 * shows. Every displayed number keeps its state; UNKNOWN / UNAVAILABLE / NOT CONNECTED are
 * rendered as explicit labels with a short human explanation, never as 0, never as a chart.
 * No React here so the mapping is unit-testable and shared by every surface.
 */
import type { Metric } from "./aggregate";
import type { WindowKey } from "./windows";

export type Tone = "ok" | "warn" | "danger" | "muted" | "info";
export type OverallStatus = "Operational" | "Partial Data" | "Setup Required" | "Attention Required";
export type HealthState = "READY" | "DEGRADED" | "UNKNOWN" | "NOT CONFIGURED" | "BLOCKED";

export type Tile = { id: string; label: string; display: string; state: "KNOWN" | "UNKNOWN" | "UNAVAILABLE"; tone: Tone; note: string | null };
export type ProviderCard = { provider: string; state: "HEALTHY" | "LIMITED" | "INSUFFICIENT" | "UNKNOWN"; tone: Tone; availability: string; balance: string; reserved: string; note: string };
export type HealthRow = { id: string; label: string; state: HealthState; tone: Tone; detail: string };

export type YouTubeSetupState = "NOT_CONFIGURED" | "MIGRATION_REQUIRED" | "NOT_CONNECTED" | "CONNECTED";

type OverviewData = {
  customers: { totalUsers: Metric; newUsers: Metric; activeUsers: Metric; subscriptions: Metric; activeSubscriptions: Metric; subscriptionsByStatus: Record<string, number> | null; mrrUsd: Metric };
  production: { total: Metric; byType: Record<string, number> | null; byState: Record<string, number> | null; averageProductionSec: Metric; retries: Metric; recoveries: Metric; staleRunning?: Metric; finalCut: { state: string; pending: number | null; inspecting: number | null; repairRequired: number | null; humanReview: number | null; pass: number | null; fail: number | null; note: string } };
  costs: { estimatedUsd: Metric; reservedUsd: Metric; actualCogsUsd: Metric; byProvider: Record<string, number>; byMediaType: Record<string, unknown>; averageCogsByProductionType: Record<string, number | null>; note: string };
  providers: { state: string; providers: { provider: string; state: "HEALTHY" | "LIMITED" | "INSUFFICIENT" | "UNKNOWN"; availability: string; balance: number | null; unit: string; reserved: number; queued: number; renewalDate: string | null; checkedAt: string; note: string }[] };
  youtube: { state: string; channelsConnected: Metric; videosLinked: Metric; lastSuccessfulSync: string | null; freshnessHours: Metric; totals: Record<string, Metric> | null; trafficSources: Record<string, number> | null; retentionAvailable: boolean; videos: { productionId: string; videoId: string; publishedAt: string | null; views: number | null; averagePercentageViewed: number | null }[] };
  systemHealth: { sources: Record<string, string>; unavailableSources: string[]; staleRunningJobs: Metric; providersUnknown: string[]; providersInsufficient: string[]; autoPublish: boolean; finalCutGate: string };
};

export type ViewModelInput = { data: OverviewData; window: WindowKey; generatedAt: string; youtubeConfigured: boolean; pwaReady: boolean };

const STATE_LABEL: Record<Metric["state"], string> = { KNOWN: "", UNKNOWN: "Unknown", UNAVAILABLE: "Unavailable" };
const fmtInt = (v: number) => new Intl.NumberFormat("en-US").format(Math.round(v));
const fmtUsd = (v: number) => `$${v.toFixed(2)}`;
const fmtMin = (v: number) => (v >= 60 ? `${(v / 60).toFixed(1)} h` : `${Math.round(v)} min`);
const fmtSec = (v: number) => (v >= 60 ? `${(v / 60).toFixed(1)} min` : `${Math.round(v)} s`);

/** Aggregation notes name tables for the API; the screen says it in human terms. */
const HUMAN_NOTES: [RegExp, string][] = [
  [/video_requests unavailable/, "Production data unavailable — database unreachable"],
  [/generation_costs unavailable/, "Cost records unavailable — database unreachable"],
  [/pi_paid_operations unavailable/, "Reservations require database migration (0023)"],
  [/yt(_\w+)? tables? unavailable|yt_\w+ unavailable/, "YouTube tables require database migration (0024–0028)"],
  [/fc_qa_decisions unavailable.*/, "Final Cut tables require database migration (0027)"],
  [/auth user listing unavailable/, "User counts unavailable"],
  [/^no cost source$/, "No cost source available"],
  [/^no requests$/, "No production data"],
];
export function humanNote(note: string | null | undefined): string | null {
  if (!note) return null;
  for (const [re, text] of HUMAN_NOTES) if (re.test(note)) return text;
  return note;
}

/** A metric becomes a tile: KNOWN shows the number; anything else shows the state word, never 0. */
export function tile(id: string, label: string, m: Metric, format: (v: number) => string = fmtInt, note?: string | null): Tile {
  const n = humanNote(note ?? m.note);
  if (m.state === "KNOWN" && m.value !== null) return { id, label, display: format(m.value), state: "KNOWN", tone: "ok", note: n };
  return { id, label, display: STATE_LABEL[m.state], state: m.state, tone: m.state === "UNAVAILABLE" ? "muted" : "warn", note: n };
}

export function youtubeSetupState(d: OverviewData, youtubeConfigured: boolean): YouTubeSetupState {
  if (d.youtube.state === "UNAVAILABLE") return "MIGRATION_REQUIRED";
  if (d.youtube.channelsConnected.state === "KNOWN" && (d.youtube.channelsConnected.value ?? 0) > 0) return "CONNECTED";
  return youtubeConfigured ? "NOT_CONNECTED" : "NOT_CONFIGURED";
}

export function overallStatus(d: OverviewData, yt: YouTubeSetupState): { status: OverallStatus; tone: Tone; reasons: string[] } {
  const reasons: string[] = [];
  const failed = d.production.byState?.failed ?? 0;
  const stale = d.systemHealth.staleRunningJobs.value ?? 0;
  if (d.systemHealth.providersInsufficient.length) reasons.push(`provider capacity insufficient: ${d.systemHealth.providersInsufficient.join(", ")}`);
  if (stale > 0) reasons.push(`${stale} job(s) running for more than 2 h`);
  if ((d.production.finalCut.humanReview ?? 0) > 0) reasons.push(`${d.production.finalCut.humanReview} master(s) waiting for human review`);
  if (failed > 0) reasons.push(`${failed} failed job(s) in this window`);
  if (reasons.length) return { status: "Attention Required", tone: "danger", reasons };
  const setup: string[] = [];
  if (d.production.total.state === "UNAVAILABLE") setup.push("production analytics require database access");
  if (d.systemHealth.sources.providers === "UNAVAILABLE" || d.production.finalCut.state === "UNAVAILABLE") setup.push("Production Intelligence / Final Cut tables require database migration");
  if (yt === "NOT_CONFIGURED") setup.push("YouTube read-only monitoring not configured");
  if (yt === "MIGRATION_REQUIRED") setup.push("YouTube tables require database migration");
  if (setup.length) return { status: "Setup Required", tone: "warn", reasons: setup };
  const partial: string[] = [];
  if (d.systemHealth.providersUnknown.length) partial.push(`provider balance unknown: ${d.systemHealth.providersUnknown.join(", ")}`);
  if (yt === "NOT_CONNECTED") partial.push("YouTube not connected");
  if (d.customers.totalUsers.state !== "KNOWN") partial.push("user counts unavailable");
  if (d.systemHealth.unavailableSources.length) partial.push(`sources unavailable: ${d.systemHealth.unavailableSources.join(", ")}`);
  if (partial.length) return { status: "Partial Data", tone: "info", reasons: partial };
  // Operational only when every source is KNOWN and no provider is UNKNOWN: UNKNOWN never produces Operational.
  return { status: "Operational", tone: "ok", reasons: ["all sources reporting"] };
}

export function buildViewModel(i: ViewModelInput) {
  const d = i.data;
  const yt = youtubeSetupState(d, i.youtubeConfigured);
  const overall = overallStatus(d, yt);
  const running = d.production.byState ? { value: d.production.byState.running, state: "KNOWN" as const } : d.production.total;
  const failed = d.production.byState ? { value: d.production.byState.failed, state: "KNOWN" as const } : d.production.total;
  const fcPending = d.production.finalCut.state === "KNOWN" ? { value: (d.production.finalCut.pending ?? 0) + (d.production.finalCut.repairRequired ?? 0) + (d.production.finalCut.humanReview ?? 0), state: "KNOWN" as const } : { value: null, state: "UNAVAILABLE" as const, note: "Final Cut tables require database migration" };
  const ytViews = d.youtube.totals?.views ?? { value: null, state: "UNAVAILABLE" as const, note: "YouTube tables unavailable" };
  const overview: Tile[] = [
    tile("users", "Users", d.customers.totalUsers),
    tile("productions", "Productions", d.production.total),
    tile("running", "Jobs running", running),
    tile("failed", "Jobs failed", failed),
    tile("fc-pending", "Final Cut pending", fcPending),
    tile("cogs", "Actual COGS", d.costs.actualCogsUsd, fmtUsd, "committed API consumption; top-ups excluded"),
    tile("yt-views", "YouTube views", ytViews, fmtInt, yt === "CONNECTED" ? null : "YouTube not connected"),
    tile("channels", "Connected channels", d.youtube.channelsConnected),
  ];
  const productionTypes = d.production.byType ? [["Reels", "reel"], ["Long Form", "long_form"], ["Avatars", "avatar"], ["TTS / Podcast", "tts_podcast"]].map(([label, key]) => ({ label, count: d.production.byType![key] ?? 0 })) : null;
  const productionStates = d.production.byState ? [["Completed", "completed"], ["Running", "running"], ["Queued", "queued"], ["Failed", "failed"]].map(([label, key]) => ({ label, count: d.production.byState![key] ?? 0 })) : null;
  const fc = d.production.finalCut;
  const finalCut = fc.state === "KNOWN" ? [["Pending", fc.pending], ["Repair required", fc.repairRequired], ["Human review", fc.humanReview], ["Pass", fc.pass], ["Fail", fc.fail]].map(([label, count]) => ({ label: String(label), count: count as number })) : null;
  const costs: Tile[] = [tile("estimated", "Estimated", d.costs.estimatedUsd, fmtUsd), tile("reserved", "Reserved", d.costs.reservedUsd, fmtUsd), tile("actual", "Actual COGS", d.costs.actualCogsUsd, fmtUsd)];
  const revenue: Tile = { id: "mrr", label: "Revenue / MRR", display: "Unavailable", state: "UNAVAILABLE", tone: "muted", note: "Stripe not connected" };
  const providers: ProviderCard[] = d.providers.state === "UNAVAILABLE" ? [] : d.providers.providers.map((p) => ({
    provider: p.provider === "openai" ? "OpenAI" : p.provider === "runway" ? "Runway" : p.provider === "elevenlabs" ? "ElevenLabs" : p.provider === "veo" ? "Veo" : p.provider,
    state: p.state, tone: p.state === "HEALTHY" ? "ok" : p.state === "LIMITED" ? "warn" : p.state === "INSUFFICIENT" ? "danger" : "muted",
    availability: p.availability === "UP" ? "Up" : p.availability === "UNVERIFIED" ? "Unverified" : "Down", balance: p.balance === null ? "Unavailable" : `${fmtInt(p.balance)} ${p.unit === "usd" ? "USD" : p.unit === "character" ? "chars" : p.unit}`, reserved: `${fmtInt(p.reserved)} ${p.unit === "usd" ? "USD" : p.unit === "character" ? "chars" : p.unit}`, note: p.state === "UNKNOWN" ? "Provider balance unavailable" : p.note,
  }));
  const ytTiles: Tile[] = yt === "CONNECTED" && d.youtube.totals ? [
    tile("yt-channels", "Channels", d.youtube.channelsConnected), tile("yt-videos", "Videos linked", d.youtube.videosLinked), tile("yt-views2", "Views", d.youtube.totals.views), tile("yt-watch", "Watch time", d.youtube.totals.watchTimeMinutes, fmtMin),
    tile("yt-avd", "Avg view duration", d.youtube.totals.averageViewDurationSeconds, fmtSec), tile("yt-apv", "Avg % viewed", d.youtube.totals.averagePercentageViewed, (v) => `${v.toFixed(1)}%`), tile("yt-subs-g", "Subscribers gained", d.youtube.totals.subscribersGained), tile("yt-subs-l", "Subscribers lost", d.youtube.totals.subscribersLost),
    tile("yt-fresh", "Analytics freshness", d.youtube.freshnessHours, (v) => `${v.toFixed(0)} h ago`),
  ] : [];
  const health: HealthRow[] = [
    { id: "database", label: "Database", ...(d.production.total.state === "UNAVAILABLE" ? { state: "BLOCKED", tone: "danger", detail: "video_requests unreachable" } : { state: "READY", tone: "ok", detail: "core tables reachable" }) },
    { id: "production", label: "Production", ...(d.production.total.state === "UNAVAILABLE" ? { state: "UNKNOWN", tone: "warn", detail: "no production data" } : (d.systemHealth.staleRunningJobs.value ?? 0) > 0 ? { state: "DEGRADED", tone: "warn", detail: `${d.systemHealth.staleRunningJobs.value} stale running job(s)` } : { state: "READY", tone: "ok", detail: "pipeline reporting" }) },
    { id: "final-cut", label: "Final Cut", ...(d.production.finalCut.state === "UNAVAILABLE" ? { state: "NOT CONFIGURED", tone: "muted", detail: "migration 0027 required" } : d.systemHealth.finalCutGate === "ACTIVE" ? { state: "READY", tone: "ok", detail: "editorial gate active before distribution" } : { state: "BLOCKED", tone: "danger", detail: "FINAL_CUT_ENABLED=false" }) },
    { id: "providers", label: "Providers", ...(d.providers.state === "UNAVAILABLE" ? { state: "NOT CONFIGURED", tone: "muted", detail: "capacity snapshots require migration 0023" } : d.systemHealth.providersInsufficient.length ? { state: "BLOCKED", tone: "danger", detail: `insufficient: ${d.systemHealth.providersInsufficient.join(", ")}` } : d.systemHealth.providersUnknown.length ? { state: "UNKNOWN", tone: "warn", detail: `unverified balance: ${d.systemHealth.providersUnknown.join(", ")}` } : { state: "READY", tone: "ok", detail: "all balances verified" }) },
    { id: "youtube", label: "YouTube", ...(yt === "CONNECTED" ? { state: "READY", tone: "ok", detail: "read-only monitoring connected" } : yt === "NOT_CONNECTED" ? { state: "NOT CONFIGURED", tone: "muted", detail: "connection required (read-only)" } : yt === "MIGRATION_REQUIRED" ? { state: "NOT CONFIGURED", tone: "muted", detail: "migrations 0024–0028 required" } : { state: "NOT CONFIGURED", tone: "muted", detail: "Google OAuth not configured" }) },
    { id: "pwa", label: "PWA", ...(i.pwaReady ? { state: "READY", tone: "ok", detail: "installable (manifest + icons)" } : { state: "NOT CONFIGURED", tone: "muted", detail: "manifest missing" }) },
  ] as HealthRow[];
  return {
    window: i.window, generatedAt: i.generatedAt, overall, overview,
    production: { types: productionTypes, states: productionStates, averageProductionTime: tile("avg", "Average production time", d.production.averageProductionSec, fmtSec), finalCut, finalCutNote: fc.state === "KNOWN" ? fc.note : "Production analytics require database migration (0027)" },
    costs: { tiles: costs, revenue, byProvider: Object.keys(d.costs.byProvider).length ? Object.entries(d.costs.byProvider).map(([provider, usd]) => ({ provider, display: fmtUsd(usd) })) : null, note: d.costs.note },
    providers: { cards: providers, unavailableNote: d.providers.state === "UNAVAILABLE" ? "Provider capacity requires database migration (0023)" : providers.length ? null : "No capacity snapshot recorded yet" },
    youtube: { setup: yt, tiles: ytTiles, videos: yt === "CONNECTED" ? d.youtube.videos : [], trafficSources: yt === "CONNECTED" ? d.youtube.trafficSources : null, retentionAvailable: yt === "CONNECTED" && d.youtube.retentionAvailable },
    health,
  };
}
export type CommandCenterViewModel = ReturnType<typeof buildViewModel>;
