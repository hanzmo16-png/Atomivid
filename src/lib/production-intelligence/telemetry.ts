/**
 * Append-only telemetry. Events are never updated: late outcomes (user kept,
 * project exported, refund) are new events referencing the attempt. Telemetry
 * has no write path into policy. Technical pass, visual QA pass, user kept and
 * exported/no-refund are separate fields and are never collapsed into one PASS.
 */
import { z } from "zod";
import { containsSecretValue } from "./capacity/accounts";

const FORBIDDEN_KEYS = ["apikey", "api_key", "token", "secret", "authorization", "password", "bearer"];

const Versions = {
  contractVersion: z.string(),
  profileVersion: z.string(),
  policyVersion: z.string(),
  memorySnapshotId: z.string(),
  rateCardVersion: z.string(),
};

export const AttemptEventSchema = z.object({
  type: z.literal("attempt"),
  eventId: z.string(),
  attemptId: z.string(),
  projectId: z.string(),
  shotId: z.string(),
  ...Versions,
  provider: z.string(),
  model: z.string(),
  modelVersion: z.string(), // "unknown" when the provider does not expose it; never invented
  productionMethod: z.string(),
  shotClass: z.string(),
  generatedSeconds: z.number().nonnegative(),
  acceptedSeconds: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  latencySeconds: z.number().nonnegative().nullable(),
  attempt: z.number().int().positive(),
  technicalPass: z.boolean().nullable(),
  visualQaPass: z.boolean().nullable(),
  failureReason: z.string().nullable(),
  fallback: z.string().nullable(),
  humanIntervention: z.enum(["none", "human"]),
  checksum: z.string().nullable(),
  timestamp: z.string(),
});

export const OutcomeEventSchema = z.object({
  type: z.literal("outcome"),
  eventId: z.string(),
  attemptId: z.string(),
  projectId: z.string(),
  userKept: z.boolean().optional(),
  projectExported: z.boolean().optional(),
  refundOccurred: z.boolean().optional(),
  note: z.string().optional(),
  timestamp: z.string(),
});

export const DecisionEventSchema = z.object({
  type: z.literal("decision"),
  eventId: z.string(),
  projectId: z.string(),
  shotId: z.string(),
  ...Versions,
  mode: z.enum(["active", "shadow"]),
  method: z.string(),
  maxCostUsd: z.number(),
  reasons: z.array(z.string()),
  decisionHash: z.string(),
  timestamp: z.string(),
});

export const TelemetryEventSchema = z.discriminatedUnion("type", [AttemptEventSchema, OutcomeEventSchema, DecisionEventSchema]);
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;
export type AttemptEvent = z.infer<typeof AttemptEventSchema>;
export type OutcomeEvent = z.infer<typeof OutcomeEventSchema>;

export class TelemetrySecretError extends Error {}

export function assertNoSecrets(v: unknown, path = "$"): void {
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.some((f) => k.toLowerCase().includes(f))) throw new TelemetrySecretError(`Forbidden key ${path}.${k}`);
      assertNoSecrets(val, `${path}.${k}`);
    }
  }
  if (typeof v === "string" && containsSecretValue(v)) throw new TelemetrySecretError(`Credential-like value at ${path}`);
}

export interface TelemetrySink {
  append(e: TelemetryEvent): Promise<void>;
  all(): Promise<readonly TelemetryEvent[]>;
}

/** In-memory append-only sink (tests, simulations). Duplicate eventIds are ignored (idempotent). */
export function memorySink(): TelemetrySink {
  const events: TelemetryEvent[] = [];
  return {
    async append(e) {
      const parsed = TelemetryEventSchema.parse(e);
      assertNoSecrets(parsed);
      if (events.some((x) => x.eventId === parsed.eventId)) return;
      events.push(Object.freeze(parsed) as TelemetryEvent);
    },
    async all() { return Object.freeze([...events]); },
  };
}
