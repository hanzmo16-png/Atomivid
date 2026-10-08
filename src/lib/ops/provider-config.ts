/**
 * Signed, secret-free probe of what the RUNNING deployment sees for the voice provider.
 * It reports presence only (never a value), env var NAMES matching ELEVEN, the deployment's
 * commit, and the account's voice count / whether "Hans podcast" exists (free GET, no audio).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { listAccountVoices, VoicesUnavailableError } from "@/lib/podcast/voices";
import { heygenApiSnapshot } from "@/lib/supply/heygen";

export const PROVIDER_CONFIG_PATH = "/api/internal/provider-config";

export function providerConfigSignature(secret: string, nonce: string, timestamp: string): string {
  return createHmac("sha256", secret).update(`atomivid-provider-config-v1\nPOST\n${PROVIDER_CONFIG_PATH}\n${nonce}\n${timestamp}`).digest("hex");
}

export function validProviderConfigSignature(secret: string | undefined, nonce: string, timestamp: string | null, signature: string | null, now = Date.now()): boolean {
  if (!secret || secret.length < 32 || !/^[0-9a-f-]{36}$/i.test(nonce) || !timestamp || !/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 300_000 || !signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(providerConfigSignature(secret, nonce, timestamp)));
}

export type ProviderConfigReport = {
  vercelEnv: string | null;
  commit: string | null;
  elevenlabsKey: "present" | "blank" | "missing";
  elevenEnvNames: string[];
  voices: { ok: true; count: number; hansPodcast: boolean } | { ok: false; error: string };
  heygen: HeygenProbe;
};

/** Public part: categories/booleans only. `sealed` (balance, raw billing_type) must only be printed encrypted. */
export type HeygenProbe = {
  key: "present" | "blank" | "missing" | "masked";
  usersMe: { http: number | null; transportError: boolean };
  shape: { billingTypeWallet: boolean; walletPresent: boolean; currency: "usd" | "credits" | "other" | "missing"; balanceNumeric: boolean; balanceNonNegative: boolean } | null;
  snapshot: { reliability: string; unit: string; health: string; availablePresent: boolean };
  legacyUsdWalletReader: boolean;
  sealed: { billingType: string | null; currency: string | null; balance: number | null } | null;
};

export async function heygenProbe(env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): Promise<HeygenProbe> {
  const raw = env.HEYGEN_API_KEY;
  const key: HeygenProbe["key"] = raw === undefined ? "missing" : !raw.trim() ? "blank" : /[•●*\s]/.test(raw.trim()) ? "masked" : "present";
  // Same reader production uses for supply (identities discarded inside).
  const snap = await heygenApiSnapshot(fetchImpl, { HEYGEN_API_KEY: raw?.trim() || undefined }, new Date().toISOString());
  const out: HeygenProbe = { key, usersMe: { http: null, transportError: false }, shape: null,
    snapshot: { reliability: snap.reliability, unit: snap.unit, health: snap.health, availablePresent: snap.available !== null }, legacyUsdWalletReader: false, sealed: null };
  if (key !== "present") return out;
  try {
    const r = await fetchImpl("https://api.heygen.com/v3/users/me", { method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000), headers: { "X-Api-Key": raw!.trim() } });
    out.usersMe.http = r.status;
    if (r.ok) {
      const d = ((await r.json().catch(() => null)) as { data?: { billing_type?: unknown; wallet?: { currency?: unknown; remaining_balance?: unknown } } } | null)?.data;
      const c = d?.wallet?.currency, b = d?.wallet?.remaining_balance;
      out.shape = { billingTypeWallet: d?.billing_type === "wallet", walletPresent: !!d?.wallet, currency: c === "usd" ? "usd" : c === "credits" ? "credits" : c === undefined || c === null ? "missing" : "other",
        balanceNumeric: typeof b === "number" && Number.isFinite(b), balanceNonNegative: typeof b === "number" && b >= 0 };
      out.legacyUsdWalletReader = c === "usd" && typeof b === "number" && Number.isFinite(b);
      out.sealed = { billingType: typeof d?.billing_type === "string" ? d.billing_type.slice(0, 40) : null, currency: typeof c === "string" ? c.slice(0, 20) : null, balance: typeof b === "number" ? b : null };
    }
  } catch { out.usersMe.transportError = true; }
  return out;
}

export async function providerConfigReport(env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): Promise<ProviderConfigReport> {
  const raw = env.ELEVENLABS_API_KEY;
  const elevenlabsKey = raw === undefined ? "missing" : raw.trim() ? "present" : "blank";
  let voices: ProviderConfigReport["voices"];
  try {
    const list = await listAccountVoices({ env, fetchImpl, fresh: true });
    voices = { ok: true, count: list.length, hansPodcast: list.some((v) => /hans\s*podcast/i.test(v.name)) };
  } catch (e) {
    voices = { ok: false, error: e instanceof VoicesUnavailableError ? e.customerMessage : "error" };
  }
  return { vercelEnv: env.VERCEL_ENV ?? null, commit: env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null, elevenlabsKey,
    elevenEnvNames: Object.keys(env).filter((k) => /ELEVEN|HEYGEN/i.test(k)).sort(), voices, heygen: await heygenProbe(env, fetchImpl) };
}
