// Read-only signed probe of the RUNNING production deployment: presence of configuration keys only ("present" /
// "blank" / "missing"), never a value. Uses the same HMAC signature as the ops probe (service role key).
import { randomUUID } from "node:crypto";
import { PROVIDER_CONFIG_PATH, providerConfigSignature } from "../../src/lib/ops/provider-config";

async function main() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) { console.log("FAIL sonda: missing SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
  const nonce = randomUUID(), time = String(Date.now());
  const res = await fetch(`https://atomivid.vercel.app${PROVIDER_CONFIG_PATH}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
    headers: { "x-probe-nonce": nonce, "x-probe-time": time, "x-probe-signature": providerConfigSignature(key, nonce, time) } });
  if (!res.ok) { console.log(`FAIL sonda: HTTP ${res.status}`); process.exit(1); }
  const r = (await res.json()) as { keys?: Record<string, string>; vercelEnv?: string | null; commit?: string | null };
  console.log(JSON.stringify({ vercelEnv: r.vercelEnv, commit: r.commit, keys: r.keys }, null, 1));
}
main().catch((e) => { console.log(`FAIL sonda: ${String(e)}`); process.exit(1); });
