/**
 * Business Telemetry V0 — ingestion health from facts only. UNKNOWN is never HEALTHY: without
 * an observed successful write (or without the ledger itself) nothing can be called healthy.
 * No alerts, no automation.
 */
export type TelemetryHealthState = "HEALTHY" | "DEGRADED" | "UNKNOWN";
export type TelemetryHealthFacts = {
  /** null = could not be determined (table missing / query failed) */
  storeAvailable: boolean | null;
  lastSuccessfulWriteAt: string | null;
  eventsRecorded: number | null;
  validationFailures: number | null;
  persistenceFailures: number | null;
  now: string;
  /** a write older than this is stale only if something was expected; V0 has no expectation, so it only adds a reason */
  staleAfterHours?: number;
};

export function telemetryHealth(f: TelemetryHealthFacts): { state: TelemetryHealthState; reasons: string[] } {
  const reasons: string[] = [];
  if (f.storeAvailable !== true) return { state: "UNKNOWN", reasons: [f.storeAvailable === false ? "ledger unavailable (migration 0030 not applied or query failed)" : "ledger availability not determined"] };
  if (f.persistenceFailures === null || f.validationFailures === null) reasons.push("rejection facts not available");
  if (!f.lastSuccessfulWriteAt || f.eventsRecorded === null || f.eventsRecorded === 0) return { state: "UNKNOWN", reasons: [...reasons, "no successful write observed yet"] };
  if ((f.persistenceFailures ?? 0) > 0) reasons.push(`${f.persistenceFailures} persistence failure(s)`);
  if ((f.validationFailures ?? 0) > 0) reasons.push(`${f.validationFailures} validation failure(s)`);
  const ageH = (Date.parse(f.now) - Date.parse(f.lastSuccessfulWriteAt)) / 36e5;
  if (f.staleAfterHours && ageH > f.staleAfterHours) reasons.push(`last write ${Math.floor(ageH)}h ago`);
  return { state: reasons.length ? "DEGRADED" : "HEALTHY", reasons };
}
