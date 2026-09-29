/**
 * youtube:doctor — read-only go-live diagnosis. Prints presence/validity only; never a secret.
 * Usage: npx tsx scripts/youtube-doctor.ts [--connection <id>] [--offline]
 * Database and network probes run only when reachable; otherwise the checks report UNKNOWN.
 */
import fs from "node:fs";
import { youtubeDoctor, type DoctorDeps } from "@/lib/distribution/youtube/doctor";
import { supabaseYouTubeStore } from "@/lib/distribution/youtube/store";

async function main() {
  const args = process.argv.slice(2);
  const conn = args.includes("--connection") ? args[args.indexOf("--connection") + 1] : null;
  const offline = args.includes("--offline");
  const files = fs.readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"));
  let store: DoctorDeps["store"] = null, migrationsApplied: DoctorDeps["migrationsApplied"] = null;
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const { createServiceClient } = await import("@/lib/supabase/service");
    const sb = createServiceClient();
    store = supabaseYouTubeStore(sb);
    migrationsApplied = async () => { const { data, error } = await sb.from("_migrations_applied").select("name"); return error ? null : (data ?? []).map((r: { name: string }) => r.name); };
  }
  const report = await youtubeDoctor({ env: process.env, migrationFilesPresent: files, migrationsApplied, fetch: offline ? null : (fetch as never), store, connectionId: conn, now: new Date().toISOString() });
  for (const c of report.checks) console.log(`${c.state.padEnd(7)} ${c.label.padEnd(40)} ${c.detail}`);
  console.log(`\nyoutube:doctor -> ${report.status} (${report.summary})`);
  process.exit(report.status === "READY" ? 0 : 1);
}
main().catch((e) => { console.error(`[youtube:doctor] ERROR ${e instanceof Error ? e.message : e}`); process.exit(2); });
