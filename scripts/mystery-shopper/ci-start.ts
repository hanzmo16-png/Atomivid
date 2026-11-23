/**
 * Disparo automático (workflow `automatico`): envoltorio de `ciStart` (src/lib/mystery-shopper/ci.ts).
 * Escribe la lista de trabajos en GITHUB_OUTPUT para que el mismo workflow los recorra.
 */
import { appendFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { ciStart } from "../../src/lib/mystery-shopper/ci";
import { jobStore, MS_BUCKET, type StorageApi } from "../../src/lib/mystery-shopper/jobs";

const env = process.env;
async function main() {
  const sb = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sb || !key) { console.log("[mystery-shopper:ci] rechazado: faltan los secretos de Supabase del worker"); return; }
  const store = jobStore(createClient(sb, key, { auth: { persistSession: false } }).storage.from(MS_BUCKET) as unknown as StorageApi);
  const r = await ciStart({
    repo: env.GITHUB_REPOSITORY ?? "", eventRepo: env.MS_EVENT_REPO, state: env.MS_EVENT_STATE, environment: env.MS_EVENT_ENVIRONMENT, sha: env.MS_EVENT_SHA,
    url: env.MS_EVENT_URL, autoFlag: env.MYSTERY_SHOPPER_AUTO, githubToken: env.GITHUB_TOKEN, waitMin: Number(env.MS_CI_WAIT_MIN || 30),
  }, { store, fetchImpl: fetch, sleep: (ms) => new Promise((res) => setTimeout(res, ms)), now: () => new Date(), env });
  console.log(`[mystery-shopper:ci] ${r.accepted ? "aceptado" : "rechazado"}: ${r.reason}${r.created.length ? ` · nuevos: ${r.created.join(", ")}` : ""}`);
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `jobs=${JSON.stringify(r.jobs)}\n`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
