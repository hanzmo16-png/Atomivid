/**
 * Signed, secret-free probe of what the RUNNING deployment sees for the voice provider.
 * It reports presence only (never a value), env var NAMES matching ELEVEN, the deployment's
 * commit, and the account's voice count / whether "Hans podcast" exists (free GET, no audio).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { listAccountVoices, VoicesUnavailableError } from "@/lib/podcast/voices";

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
};

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
    elevenEnvNames: Object.keys(env).filter((k) => /ELEVEN/i.test(k)).sort(), voices };
}
