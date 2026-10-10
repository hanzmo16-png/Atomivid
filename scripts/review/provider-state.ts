/**
 * Read-only provider state (no paid call, no limit change):
 *  - ElevenLabs: subscription tier, characters used/limit, reset date (GET /v1/user/subscription — free).
 *  - App supply policies for ElevenLabs (caps configured in the database), aggregates only.
 *  - Storage: which object sizes the "videos" bucket accepts now (test objects deleted at once).
 */
import { createClient } from "@supabase/supabase-js";
import { connectResolved } from "../lib/supabase-db";

const log = (tag: string, v: unknown) => console.log(tag, JSON.stringify(v));
const MiB = 1024 * 1024;

async function main() {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (key) {
    const r = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": key } });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    log("ELEVENLABS_SUBSCRIPTION", { http: r.status, tier: j.tier ?? null, status: j.status ?? null, characterCount: j.character_count ?? null, characterLimit: j.character_limit ?? null,
      remaining: typeof j.character_limit === "number" && typeof j.character_count === "number" ? (j.character_limit as number) - (j.character_count as number) : null,
      nextResetUnix: j.next_character_count_reset_unix ?? null, canExtend: j.can_extend_character_limit ?? null, allowedToExtend: j.allowed_to_extend_character_limit ?? null,
      maxCharacterLimitExtension: j.max_character_limit_extension ?? null, voiceLimit: j.voice_limit ?? null, professionalVoiceLimit: j.professional_voice_limit ?? null });
  } else log("ELEVENLABS_SUBSCRIPTION", { configured: false });

  const { client } = await connectResolved();
  try {
    await client.query("begin read only");
    const cols = (await client.query(`select column_name from information_schema.columns where table_schema='public' and table_name='pi_supply_policies'`)).rows.map((r: any) => r.column_name);
    const policies = (await client.query(`select * from public.pi_supply_policies`)).rows;
    log("SUPPLY_POLICY_COLUMNS", cols);
    for (const p of policies) log("SUPPLY_POLICY", p);
    await client.query("rollback");
  } finally { await client.end(); }

  const url = process.env.SUPABASE_URL!.trim(), sr = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
  const db = createClient(url, sr, { auth: { persistSession: false } });
  const created: string[] = [];
  try {
    for (const mb of (process.env.PROBE_MIB ?? "").split(",").filter(Boolean).map(Number)) {
      const path = `ops/size-probe/${Date.now()}-${mb}mib.bin`;
      const r = await fetch(`${url}/storage/v1/object/videos/${path}`, { method: "POST", headers: { Authorization: `Bearer ${sr}`, apikey: sr, "Content-Type": "application/octet-stream", "x-upsert": "false" }, body: Buffer.alloc(mb * MiB) });
      log("UPLOAD", { mib: mb, status: r.status, ok: r.ok });
      if (r.ok) created.push(path); else break;
    }
  } finally {
    if (created.length) { const { error } = await db.storage.from("videos").remove(created); log("CLEANUP", { removed: created.length, error: error?.message ?? null }); }
  }
}
main().catch((e) => { console.error("FAILED", e instanceof Error ? e.message.slice(0, 200) : "error"); process.exitCode = 1; });
