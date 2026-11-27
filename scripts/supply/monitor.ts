/** Unified scheduled entrypoint: official billing GETs and existing private observations only.
 * No render worker, queue resume, paid provider, webhook or payment module is imported. */
import { createClient } from "@supabase/supabase-js";
import { monitorSupply } from "../../src/lib/supply/monitor";
async function main() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !url.startsWith("https://")) throw Error("monitor configuration unavailable");
  const service = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const result = await monitorSupply(service);
  console.log(JSON.stringify({ ok: true, providers: result.states.length }));
}
main().catch(() => { console.error("Resource Sentinel incomplete; observations remain private. No production dispatched or payment requested."); process.exitCode = 1; });
