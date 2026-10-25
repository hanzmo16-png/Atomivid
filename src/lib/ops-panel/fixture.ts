/**
 * SINTÉTICO — datos de ejemplo para pruebas y vista previa del panel operativo (M5).
 * Ningún número de este archivo es real: no proviene de Supabase, de un proveedor ni de Stripe.
 * Todas las filas llevan origin: "synthetic" y los identificadores empiezan por "sintetico-".
 * Nunca se importa desde una página que lea datos reales.
 */
import type { JobRow, LedgerRow, OpsInput, PriceRow, ProjectCapRow, ProviderCapRow } from "./metrics";

const o = "synthetic" as const;
const row = (projectId: string, provider: string, method: string, status: string, reservedUsd: string, committedUsd: string | null, createdAt: string, supplyReconciled = false): LedgerRow =>
  ({ origin: o, projectId, provider, method, status, reservedUsd, committedUsd, supplyReconciled, createdAt });

export const SYNTHETIC_LEDGER: LedgerRow[] = [
  row("sintetico-reel-001", "openai", "IMAGE", "COMMITTED", "0.0400", "0.0400", "2026-10-20T15:00:00Z"),
  row("sintetico-reel-001", "elevenlabs", "TTS", "COMMITTED", "0.1000", "0.0815", "2026-10-20T15:01:00Z"),
  row("sintetico-reel-001", "runway", "I2V_ECONOMY", "COMMITTED", "0.2500", null, "2026-10-20T15:02:00Z"),
  row("sintetico-reel-002", "openai", "IMAGE", "COMMITTED", "0.0400", "0.0400", "2026-10-21T10:00:00Z"),
  row("sintetico-reel-002", "runway", "I2V_ECONOMY", "PROVIDER_JOB_RECORDED", "0.2500", null, "2026-10-21T10:02:00Z"),
  row("sintetico-largo-001", "anthropic", "SCRIPT", "COMMITTED", "0.3000", "0.1234", "2026-10-22T09:00:00Z"),
  row("sintetico-largo-001", "veo", "I2V_PREMIUM", "RECONCILIATION_REQUIRED", "1.2000", null, "2026-10-22T09:30:00Z"),
  row("sintetico-largo-001", "elevenlabs", "TTS", "REFUNDED", "0.5000", "0.0000", "2026-10-22T09:40:00Z", true),
  row("sintetico-podcast-001", "elevenlabs", "TTS", "REFUNDED", "0.2000", null, "2026-10-23T12:00:00Z", false),
  row("sintetico-podcast-001", "openai", "IMAGE", "SUBMITTED", "0.0400", null, "2026-10-24T12:00:00Z"),
  row("sintetico-podcast-001", "openai", "IMAGE", "RESERVED", "0.0400", null, "2026-10-24T12:05:00Z"),
  row("sintetico-podcast-001", "heygen", "capacity_hold", "RESERVED", "3.0000", null, "2026-10-24T12:06:00Z"),
];

export const SYNTHETIC_JOBS: JobRow[] = [
  { origin: o, id: "sintetico-reel-001", status: "completed", mode: "visual" },
  { origin: o, id: "sintetico-reel-002", status: "processing", mode: "visual" },
  { origin: o, id: "sintetico-largo-001", status: "failed", mode: "long_form" },
  { origin: o, id: "sintetico-podcast-001", status: "pending", mode: null },
];

export const SYNTHETIC_PROVIDER_CAPS: ProviderCapRow[] = [
  { origin: o, provider: "openai", dailyCapUsd: "1.0000", monthlyCapUsd: "20.0000", enabled: true },
  { origin: o, provider: "runway", dailyCapUsd: "0.5000", monthlyCapUsd: "10.0000", enabled: true },
  { origin: o, provider: "veo", dailyCapUsd: "1.0000", monthlyCapUsd: "1.0000", enabled: true },
  { origin: o, provider: "heygen", dailyCapUsd: "0", monthlyCapUsd: "0", enabled: false },
];

export const SYNTHETIC_PROJECT_CAPS: ProjectCapRow[] = [
  { origin: o, projectId: "sintetico-reel-001", capUsd: "1.0000", kind: "tope por Reel (ejemplo)" },
  { origin: o, projectId: "sintetico-largo-001", capUsd: "1.5000", kind: "presupuesto de recuperación (ejemplo)" },
];

/** Precios de EJEMPLO por video; no son tarifas reales ni cobros de Stripe. */
export const SYNTHETIC_PRICES: PriceRow[] = [
  { origin: o, projectId: "sintetico-reel-001", priceUsd: "1.2667", basis: "precio de ejemplo" },
  { origin: o, projectId: "sintetico-reel-002", priceUsd: "1.2667", basis: "precio de ejemplo" },
];

export const SYNTHETIC_INPUT: OpsInput = {
  source: { kind: "synthetic", label: "SINTÉTICO · datos de ejemplo", asOf: "2026-10-24T18:00:00Z" },
  period: { fromIso: "2026-10-01T05:00:00Z", toIso: "2026-11-01T05:00:00Z" },
  dayStartIso: "2026-10-24T05:00:00Z",
  monthStartIso: "2026-10-01T05:00:00Z",
  utcOffsetMinutes: -300,
  ledger: SYNTHETIC_LEDGER,
  jobs: SYNTHETIC_JOBS,
  providerCaps: SYNTHETIC_PROVIDER_CAPS,
  projectCaps: SYNTHETIC_PROJECT_CAPS,
  prices: SYNTHETIC_PRICES,
};
