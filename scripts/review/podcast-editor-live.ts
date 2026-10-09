/**
 * Read-only live check of the podcast-editor area in the REAL database (no write, no provider call).
 * Inside a READ ONLY transaction that is rolled back, it evaluates the approved helpers and Storage RLS as
 * the `authenticated` role for (a) each enrolled owner and (b) an ordinary account, exactly as a signed
 * request would (role + request.jwt.claims). Public log: counts and booleans; account ids are sealed.
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

async function asUser(client: import("pg").Client, sub: string) {
  await client.query("begin read only");
  try {
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub, role: "authenticated" })]);
    const owner = (await client.query("select podcast_editor.es_propietario() as v")).rows[0].v as boolean;
    const visible = Number((await client.query("select count(*)::int as n from storage.objects where bucket_id = 'podcast-editor'")).rows[0].n);
    const assignments = Number((await client.query("select count(*)::int as n from podcast_editor.asignaciones")).rows[0].n);
    return { esPropietario: owner, visibleObjects: visible, visibleAssignments: assignments };
  } finally {
    await client.query("rollback");
  }
}

async function main() {
  const { client } = await connectResolved();
  try {
    await client.query("begin read only");
    const owners = (await client.query("select user_id::text as id from podcast_editor.propietarios order by created_at")).rows as { id: string }[];
    const totals = (await client.query(`select
        (select count(*)::int from podcast_editor.asignaciones) as asignaciones,
        (select count(*)::int from storage.objects where bucket_id = 'podcast-editor') as objetos,
        (select count(*)::int from storage.objects where bucket_id = 'podcast-editor' and name like 'episodios/%/salida/COMPLETO.json') as completos,
        (select public from storage.buckets where id = 'podcast-editor') as bucket_public`)).rows[0];
    // An ordinary account for the negative case: the newest confirmed account that is not an owner.
    const other = (await client.query(`select id::text from auth.users where email_confirmed_at is not null
        and id not in (select user_id from podcast_editor.propietarios) order by created_at desc limit 1`)).rows[0]?.id as string | undefined;
    // The owner's link to existing private work (counts only).
    const travis = owners.length ? (await client.query(`select count(*)::int as n from public.video_requests where user_id = $1`, [owners[0].id])).rows[0].n : null;
    await client.query("rollback");
    log("LIVE_TOTALS", { owners: owners.length, ...totals, ownerVideoRequests: travis });
    for (const [i, o] of owners.entries()) log("AS_OWNER", { owner: i + 1, ...(await asUser(client, o.id)) });
    if (other) log("AS_ORDINARY_ACCOUNT", await asUser(client, other));
    log("AS_ANONYMOUS_SUB", await asUser(client, "00000000-0000-4000-8000-000000000000"));
    seal("podcast-editor-live.json", Buffer.from(JSON.stringify({ owners: owners.map((o) => o.id), ordinaryAccountUsed: other ?? null })));
  } finally {
    await client.end();
  }
}
main().catch((e) => { console.error("FAILED", e instanceof Error ? e.message.slice(0, 300) : "error"); process.exitCode = 1; });
