/**
 * Read-only capacity adapters. Secrets are read from the environment by their
 * reference NAME and never logged or returned. `fetchImpl` is injected so tests
 * never touch the network. No adapter here spends money.
 */
import { PROVIDER_ACCOUNTS, type ProviderAccount } from "./accounts";
import type { CapacitySnapshot } from "./capacity";

type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
type Env = Record<string, string | undefined>;
const account = (p: ProviderAccount["provider"]) => PROVIDER_ACCOUNTS.find((a) => a.provider === p)!;

/** ElevenLabs: official read-only subscription endpoint (already used by DULCE status stages). */
export async function elevenLabsSnapshot(fetchImpl: Fetch, env: Env, reservedChars: number, pendingChars: number, now: string): Promise<CapacitySnapshot> {
  const a = account("elevenlabs");
  const base: CapacitySnapshot = { provider: "elevenlabs", accountLabel: a.productionAccountLabel, unit: "character", available: null, reserved: reservedChars, pending: pendingChars, renewalDate: a.renewalDate, lastCheckedAt: now, health: "UNCHECKED", reliability: "none" };
  const key = env[a.secretReferenceName];
  if (!key) return base;
  try {
    const r = await fetchImpl("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": key } });
    if (!r.ok) return { ...base, health: r.status >= 500 ? "DEGRADED" : "DOWN" };
    const j = (await r.json()) as { character_count?: number; character_limit?: number; next_character_count_reset_unix?: number };
    if (typeof j.character_limit !== "number" || typeof j.character_count !== "number") return { ...base, health: "OK" };
    return { ...base, available: j.character_limit - j.character_count, health: "OK", reliability: "provider_api", renewalDate: j.next_character_count_reset_unix ? new Date(j.next_character_count_reset_unix * 1000).toISOString().slice(0, 10) : a.renewalDate };
  } catch {
    return { ...base, health: "DEGRADED" };
  }
}

/**
 * OpenAI: there is no official API-credit balance endpoint. We only check that the
 * key works (free model listing) and derive an informative estimate from registered
 * top-ups minus ledger consumption. The balance stays UNKNOWN.
 */
export async function openAiSnapshot(fetchImpl: Fetch, env: Env, reservedUsd: number, pendingUsd: number, now: string, money: { topupsUsd: number; consumedUsd: number }): Promise<CapacitySnapshot> {
  const a = account("openai");
  const base: CapacitySnapshot = { provider: "openai", accountLabel: a.productionAccountLabel, unit: "usd", available: null, reserved: reservedUsd, pending: pendingUsd, renewalDate: null, lastCheckedAt: now, health: "UNCHECKED", reliability: "derived_from_ledger", derivedEstimate: Math.round((money.topupsUsd - money.consumedUsd) * 100) / 100 };
  const key = env[a.secretReferenceName];
  if (!key) return base;
  try {
    const r = await fetchImpl("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
    return { ...base, health: r.ok ? "OK" : r.status === 401 || r.status === 429 ? "DOWN" : "DEGRADED" };
  } catch {
    return { ...base, health: "DEGRADED" };
  }
}

/** Runway: no verified balance endpoint yet -> UNKNOWN (informative ledger estimate only). */
export function runwaySnapshot(reservedUsd: number, pendingUsd: number, now: string, money?: { topupsUsd: number; consumedUsd: number }): CapacitySnapshot {
  const a = account("runway");
  return { provider: "runway", accountLabel: a.productionAccountLabel, unit: "usd", available: null, reserved: reservedUsd, pending: pendingUsd, renewalDate: null, lastCheckedAt: now, health: "UNCHECKED", reliability: "none", derivedEstimate: money ? Math.round((money.topupsUsd - money.consumedUsd) * 100) / 100 : null };
}
