/**
 * Command Center service: ONE server-side, read-only entry point for every future surface
 * (desktop web, mobile web, PWA). Sections mirror the future navigation; every call requires
 * an owner/admin user and never returns another user's data to a non-admin.
 */
import { requireCommandCenterAdmin, type AuthUser } from "./access";
import { timeRange, type WindowKey } from "./windows";
import type { CommandCenterSource } from "./sources";
import { aggregateCosts, aggregateCustomers, aggregateProduction, aggregateProviders, aggregateSystemHealth, aggregateYouTube } from "./aggregate";
import { distributionFlags } from "@/lib/distribution/youtube/capabilities";
import { finalCutFlags } from "@/lib/final-cut/gate";
import { aggregateTelemetry, type TelemetrySource } from "@/lib/business-telemetry/command-center";

export const SECTIONS = ["overview", "production", "customers", "costs", "providers", "youtube", "system-health", "telemetry"] as const;
export type Section = (typeof SECTIONS)[number];
export const isSection = (v: unknown): v is Section => typeof v === "string" && (SECTIONS as readonly string[]).includes(v);

/** `telemetry` is the optional read-only Business Telemetry foundation (V0): absent or failing = UNAVAILABLE, never zeros. */
export type CommandCenterDeps = { source: CommandCenterSource; telemetry?: TelemetrySource; env?: Record<string, string | undefined>; now: () => string };

export class CommandCenterService {
  constructor(private readonly deps: CommandCenterDeps) {}

  /** Builds every section from a fixed set of source calls (one query per table; no per-row fan-out). */
  async section(user: AuthUser, section: Section, window: WindowKey) {
    requireCommandCenterAdmin(user, this.deps.env);
    const now = this.deps.now();
    const range = timeRange(window, now);
    const s = this.deps.source;
    const meta = { section, window, range, generatedAt: now, readOnly: true as const };
    switch (section) {
      case "customers": { const [users, subs] = await Promise.all([s.users(range), s.subscriptions()]); return { ...meta, data: aggregateCustomers(users, subs) }; }
      case "production": { const [reqs, fc] = await Promise.all([s.requests(range), s.finalCutDecisions(range)]); const costs = reqs ? await s.costs(reqs.map((r) => r.id)) : null; return { ...meta, data: aggregateProduction(reqs, costs, fc, now) }; }
      case "costs": { const [reqs, ops] = await Promise.all([s.requests(range), s.paidOps(range)]); const costs = reqs ? await s.costs(reqs.map((r) => r.id)) : null; return { ...meta, data: aggregateCosts(reqs, costs, ops) }; }
      case "providers": return { ...meta, data: aggregateProviders(await s.capacity()) };
      case "telemetry": return { ...meta, data: await this.telemetry(now) };
      case "youtube": { const [ch, links, rows] = await Promise.all([s.youtubeChannels(), s.youtubeLinks(), s.youtubeRows(range)]); return { ...meta, data: aggregateYouTube(ch, links, rows, now) }; }
      case "system-health": case "overview": {
        const [reqs, fc, ops, cap, ch, links, rows, users, subs] = await Promise.all([s.requests(range), s.finalCutDecisions(range), s.paidOps(range), s.capacity(), s.youtubeChannels(), s.youtubeLinks(), s.youtubeRows(range), s.users(range), s.subscriptions()]);
        const costs = reqs ? await s.costs(reqs.map((r) => r.id)) : null;
        const production = aggregateProduction(reqs, costs, fc, now), providers = aggregateProviders(cap), youtube = aggregateYouTube(ch, links, rows, now);
        const flags = { autoPublish: distributionFlags(this.deps.env ?? process.env).AUTO_PUBLISH, finalCutEnabled: finalCutFlags(this.deps.env ?? process.env).enabled };
        const health = aggregateSystemHealth({ production, providers, youtube, flags });
        const telemetry = await this.telemetry(now);
        if (section === "system-health") return { ...meta, data: { ...health, telemetry } };
        return { ...meta, data: { customers: aggregateCustomers(users, subs), production, costs: aggregateCosts(reqs, costs, ops), providers, youtube, systemHealth: health, telemetry } };
      }
    }
  }

  /** Business Telemetry status (events collected, last event, ingestion health). No source or a failing one → UNAVAILABLE. */
  private async telemetry(now: string) {
    if (!this.deps.telemetry) return aggregateTelemetry(null, now);
    try { return aggregateTelemetry(await this.deps.telemetry.summary(), now); } catch { return aggregateTelemetry(null, now); }
  }
}
