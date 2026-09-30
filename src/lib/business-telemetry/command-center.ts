/**
 * Business Telemetry V0 — read-only foundation for the Command Center (data layer only; the
 * screen is untouched). Reports what the ledger contains: events collected, last event, last
 * write, rejections. No data → UNKNOWN / UNAVAILABLE, never a fabricated number.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { telemetryHealth, type TelemetryHealthState } from "./health";

export type TelemetrySummary = {
  eventsTotal: number;
  lastEventOccurredAt: string | null;
  lastRecordedAt: string | null;
  rejectionsTotal: number | null;
  lastRejectionAt: string | null;
  persistenceFailures: number | null;
};
/** `null` = ledger UNAVAILABLE (migration 0030 not applied, query failed). */
export interface TelemetrySource { summary(): Promise<TelemetrySummary | null>; }

export type Metric = { value: number | null; state: "KNOWN" | "UNKNOWN" | "UNAVAILABLE"; note?: string };
export type TelemetryStatus = {
  state: "KNOWN" | "UNAVAILABLE";
  health: TelemetryHealthState;
  healthReasons: string[];
  eventsCollected: Metric;
  lastEventAt: string | null;
  lastWriteAt: string | null;
  rejections: Metric;
  note: string;
};

export function aggregateTelemetry(s: TelemetrySummary | null, now: string): TelemetryStatus {
  if (!s) return { state: "UNAVAILABLE", health: "UNKNOWN", healthReasons: ["ledger unavailable (migration 0030 not applied or query failed)"], eventsCollected: { value: null, state: "UNAVAILABLE", note: "business_events unavailable" }, lastEventAt: null, lastWriteAt: null, rejections: { value: null, state: "UNAVAILABLE", note: "business_event_rejections unavailable" }, note: "Business telemetry not available" };
  const h = telemetryHealth({ storeAvailable: true, lastSuccessfulWriteAt: s.lastRecordedAt, eventsRecorded: s.eventsTotal, validationFailures: s.rejectionsTotal === null ? null : s.rejectionsTotal - (s.persistenceFailures ?? 0), persistenceFailures: s.persistenceFailures, now });
  return {
    state: "KNOWN", health: h.state, healthReasons: h.reasons,
    eventsCollected: s.eventsTotal === 0 ? { value: 0, state: "KNOWN", note: "no business events collected yet: event emission is not connected (ledger only); production and cost figures come from video_requests, generation_costs and the paid-operation ledger, never from this count" } : { value: s.eventsTotal, state: "KNOWN" },
    lastEventAt: s.lastEventOccurredAt, lastWriteAt: s.lastRecordedAt,
    rejections: s.rejectionsTotal === null ? { value: null, state: "UNKNOWN", note: "rejection log unavailable" } : { value: s.rejectionsTotal, state: "KNOWN" },
    note: "observed facts only; nothing projected",
  };
}

/** Structural view of the in-memory ledger store / rejection sink (business-telemetry/ledger.ts); used by tests only. */
type MemoryEventReader = { list(): { occurredAt: string }[]; lastSuccessfulWriteAt: string | null };
type MemoryRejectionReader = { rejections: { rejectedAt: string; reason: string }[] };

export function memoryTelemetrySource(store: MemoryEventReader, sink?: MemoryRejectionReader, opts: { unavailable?: boolean } = {}): TelemetrySource {
  return {
    async summary() {
      if (opts.unavailable) return null;
      const events = store.list();
      const last = events.reduce<string | null>((m, e) => (m === null || e.occurredAt > m ? e.occurredAt : m), null);
      const rej = sink?.rejections ?? null;
      return { eventsTotal: events.length, lastEventOccurredAt: last, lastRecordedAt: store.lastSuccessfulWriteAt, rejectionsTotal: rej ? rej.length : null, lastRejectionAt: rej && rej.length ? rej[rej.length - 1].rejectedAt : null, persistenceFailures: rej ? rej.filter((r) => r.reason === "persistence_failure").length : null };
    },
  };
}

/** Service-role, fixed number of queries (4), errors → null. */
export function supabaseTelemetrySource(sb: SupabaseClient): TelemetrySource {
  return {
    async summary() {
      try {
        const count = await sb.from("business_events").select("event_id", { count: "exact", head: true });
        if (count.error) return null;
        const lastEv = await sb.from("business_events").select("occurred_at,recorded_at").order("recorded_at", { ascending: false }).limit(1).maybeSingle();
        if (lastEv.error) return null;
        const lastOcc = await sb.from("business_events").select("occurred_at").order("occurred_at", { ascending: false }).limit(1).maybeSingle();
        const rej = await sb.from("business_event_rejections").select("id", { count: "exact", head: true });
        const pers = rej.error ? null : await sb.from("business_event_rejections").select("id", { count: "exact", head: true }).eq("reason", "persistence_failure");
        const lastRej = rej.error ? null : await sb.from("business_event_rejections").select("rejected_at").order("rejected_at", { ascending: false }).limit(1).maybeSingle();
        return {
          eventsTotal: count.count ?? 0,
          lastEventOccurredAt: lastOcc.data?.occurred_at ? new Date(String(lastOcc.data.occurred_at)).toISOString() : null,
          lastRecordedAt: lastEv.data?.recorded_at ? new Date(String(lastEv.data.recorded_at)).toISOString() : null,
          rejectionsTotal: rej.error ? null : rej.count ?? 0,
          lastRejectionAt: lastRej?.data?.rejected_at ? new Date(String(lastRej.data.rejected_at)).toISOString() : null,
          persistenceFailures: pers && !pers.error ? pers.count ?? 0 : null,
        };
      } catch { return null; }
    },
  };
}
