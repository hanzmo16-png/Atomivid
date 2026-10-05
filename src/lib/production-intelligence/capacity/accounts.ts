/**
 * Provider Account Registry: NON-SECRET metadata only. It names which account
 * production uses and where its secret lives (an env/secret NAME, never a value).
 * Written from what the repo records (DULCE Part I provider-balance.json, workflows).
 */
export type ProviderAccount = {
  provider: "elevenlabs" | "openai" | "runway";
  productionAccountLabel: string;
  workspaceIdentifier: string | null;
  plan: string;
  secretReferenceName: string;
  renewalDate: string | null;
  status: "active" | "suspended" | "unknown";
  balanceSource: "provider_api" | "derived_from_ledger" | "none";
  notes: string;
};

export const PROVIDER_ACCOUNTS: ProviderAccount[] = [
  {
    provider: "elevenlabs",
    productionAccountLabel: "ATOMIVID production (GitHub secret ELEVENLABS_API_KEY)",
    workspaceIdentifier: null,
    plan: "starter",
    secretReferenceName: "ELEVENLABS_API_KEY",
    renewalDate: null,
    status: "active",
    balanceSource: "provider_api",
    notes: "Balance from GET /v1/user/subscription (character_limit - character_count). The UI showed a different workspace once; always trust the API key's account. Owner top-up USD 5 on 2026-09-28; Creator was NOT bought.",
  },
  {
    provider: "openai",
    productionAccountLabel: "ATOMIVID production (GitHub secret OPENAI_API_KEY)",
    workspaceIdentifier: null,
    plan: "pay-as-you-go",
    secretReferenceName: "OPENAI_API_KEY",
    renewalDate: null,
    status: "active",
    balanceSource: "derived_from_ledger",
    notes: "No official API-credit balance endpoint: balance is UNKNOWN; estimate = registered top-ups - ledger consumption. insufficient_quota stopped DULCE once. Owner top-up USD 10 on 2026-09-28.",
  },
  {
    provider: "runway",
    productionAccountLabel: "ATOMIVID production (GitHub secret RUNWAY_API_KEY)",
    workspaceIdentifier: null,
    plan: "dev API, usage tier 1 (observed 2026-09-27)",
    secretReferenceName: "RUNWAY_API_KEY",
    renewalDate: null,
    status: "active",
    balanceSource: "none",
    notes: "No verified balance endpoint in the repo; docs were not reachable from this environment. Balance is UNKNOWN until an official endpoint is verified. Tier 1: concurrency 1, 50 generations/24 h.",
  },
];

/** Values that look like credentials must never appear in the registry, telemetry or logs (checksums are allowed). */
export const SECRET_VALUE_PATTERNS = [/sk-[A-Za-z0-9_-]{16,}/, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, /key_[A-Za-z0-9]{24,}/, /AIza[0-9A-Za-z_-]{30,}/, /ya29\.[0-9A-Za-z_-]+/, /1\/\/[0-9A-Za-z_-]{20,}/];

export function containsSecretValue(v: unknown): boolean {
  const s = JSON.stringify(v);
  return SECRET_VALUE_PATTERNS.some((re) => re.test(s));
}
