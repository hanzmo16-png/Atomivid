/**
 * Read-only production state for the owner's own production journey (no write, no provider call).
 * Public log: aggregates only. Per-request details (ids, stages, error messages) are sealed.
 */
import { createCipheriv, publicEncrypt, randomBytes, constants } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connectResolved } from "../lib/supabase-db";

const log = (tag: string, v: unknown) => console.log(tag, JSON.stringify(v));
mkdirSync("sealed-out", { recursive: true });
function seal(name: string, bytes: Buffer) {
  const key = randomBytes(32), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(bytes), c.final()]);
  const ek = publicEncrypt({ key: readFileSync("ops/session-public-key.txt", "utf8"), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  writeFileSync(`sealed-out/${name}.sealed`, [ek, iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join("."));
  log("SEALED_FILE", { name, bytes: bytes.length });
}

async function main() {
  const { client } = await connectResolved();
  try {
    await client.query("begin read only");
    const owner = (await client.query("select user_id from podcast_editor.propietarios limit 1")).rows[0]?.user_id;
    const agg = (await client.query(`select mode, status, count(*)::int n, max(duration_seconds)::int max_s
      from public.video_requests where user_id=$1 and created_at > now() - interval '30 days' group by 1,2 order by 1,2`, [owner])).rows;
    log("OWNER_REQUESTS_30D", agg);
    const cols = (await client.query(`select column_name from information_schema.columns where table_schema='public' and table_name='video_requests'`)).rows.map((r: any) => r.column_name);
    const want = ["id","mode","status","duration_seconds","progress_stage","long_form_stage","render_attempts","error_message","created_at","updated_at","supply_wait_started_at","long_form_confirmed_at","video_path"].filter((c) => cols.includes(c));
    const detail = (await client.query(`select ${want.join(",")} from public.video_requests where user_id=$1 and created_at > now() - interval '30 days' order by created_at desc limit 40`, [owner])).rows;
    const pod = (await client.query(`select status, source, count(*)::int n, max(duration_seconds)::numeric max_s from public.podcast_episodes where user_id=$1 group by 1,2`, [owner])).rows;
    log("OWNER_PODCASTS", pod);
    const podDetail = (await client.query(`select * from public.podcast_episodes where user_id=$1 order by created_at desc limit 10`, [owner])).rows
      .map((r: any) => ({ id: r.id, status: r.status, source: r.source, duration_seconds: r.duration_seconds, error: r.error_message ?? r.error ?? null, created_at: r.created_at }));
    const ledger = (await client.query(`select provider, status, count(*)::int n, round(sum(coalesce(committed_usd,0))::numeric,2) usd
      from public.pi_paid_operations where created_at > now() - interval '30 days' group by 1,2 order by 1,2`)).rows;
    log("LEDGER_30D", ledger);
    await client.query("rollback");
    seal("platform-state.json", Buffer.from(JSON.stringify({ requests: detail, podcasts: podDetail }, null, 1)));
  } finally { await client.end(); }
}
main().catch((e) => { console.error("FAILED", e instanceof Error ? e.message.slice(0, 200) : "error"); process.exitCode = 1; });
