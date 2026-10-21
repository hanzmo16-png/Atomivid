// Re-run 2026-10-21: owner secret added in GitHub Actions.
/** Read-only readiness check for the Recraft + chosen-voice pilot (2026-10-21). No writes, no generation, no paid
 * call: Supabase reads (service role), ElevenLabs GET /v1/voices and GET /v1/user/subscription. Prints booleans,
 * counts and labels only — never a secret, an email or a user id. */
import { createClient } from "@supabase/supabase-js";

const env = process.env;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const log = (k: string, v: unknown) => console.log(k, JSON.stringify(v));

async function main() {
  const db = createClient(env.SUPABASE_URL!.trim(), env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const ownerId = env.INTERNAL_PRODUCTION_OWNER_USER_ID?.trim().toLowerCase() ?? "";
  const { data: owner } = UUID.test(ownerId) ? await db.auth.admin.getUserById(ownerId) : { data: null };
  const ownerEmail = owner?.user?.email?.toLowerCase() ?? null;
  log("PRESENCE", Object.fromEntries(["INTERNAL_PRODUCTION_OWNER_USER_ID", "CAND_VAR_OWNER", "CAND_SECRET_PILOT", "CAND_VAR_PILOT", "CAND_FAL_ADMIN", "CAND_FAL_KEY", ...Object.keys(env).filter((k) => k.startsWith("SEC_"))].map((k) => [k, !!env[k]?.trim()])));
  log("OWNER", { secretPresent: !!ownerId, wellFormed: UUID.test(ownerId), accountExists: !!owner?.user, emailConfirmed: !!owner?.user?.email_confirmed_at });
  // Recraft gate as the worker evaluates it (recraft-access.ts): open to everyone only when RECRAFT_REEL_ENABLED is true.
  log("LONG_FORM_REAL_RUN_CONFIRM_OK", (env.SEC_LONG_FORM_REAL_RUN_CONFIRM ?? "").trim() === "YES_SPEND_REAL_MONEY");
  log("RECRAFT_GATE", { RECRAFT_REEL_ENABLED: env.RECRAFT_REEL_ENABLED ?? null, openToAllUsers: (env.RECRAFT_REEL_ENABLED ?? "").trim().toLowerCase() === "true",
    pilotOwnerPassedToWorker: !!ownerId });

  const mig = await db.from("_migrations_applied").select("name").in("name", ["20261021090000_reel_recraft_images.sql", "20261021160000_long_form_recraft_images.sql",
    "20261021170000_recraft_provider_account.sql", "20261021180000_long_form_voice_selection.sql"]);
  log("MIGRATIONS_REGISTERED", { readError: mig.error?.code ?? null, names: (mig.data ?? []).map((r) => r.name).sort() });
  const acct = await db.from("pi_provider_accounts").select("provider,plan,secret_reference_name,status,balance_source").eq("provider", "recraft").maybeSingle();
  log("RECRAFT_ACCOUNT", { readError: acct.error?.code ?? null, row: acct.data });
  const pol = await db.from("pi_supply_policies").select("*").eq("provider", "recraft").maybeSingle();
  const p = pol.data as Record<string, unknown> | null;
  log("RECRAFT_POLICY", { readError: pol.error?.code ?? null, exists: !!p, enabled: p?.enabled ?? null, unit: p?.unit ?? null, unit_cost_usd: p?.unit_cost_usd ?? null,
    daily_cap_usd: p?.daily_cap_usd ?? null, monthly_cap_usd: p?.monthly_cap_usd ?? null, max_concurrent: p?.max_concurrent ?? null, max_daily_calls: p?.max_daily_calls ?? null });
  for (const provider of ["recraft", "elevenlabs"]) {
    const s = await db.from("pi_capacity_snapshots").select("unit,available,health,reliability,status,checked_at").eq("provider", provider).order("checked_at", { ascending: false }).limit(1).maybeSingle();
    log("LATEST_SNAPSHOT", { provider, readError: s.error?.code ?? null, snapshot: s.data });
  }
  // Schema shape of the voice/recraft columns (PostgREST select on the new columns).
  const cols = await db.from("video_requests").select("reel_voice_id,reel_image_source,reel_recraft_style,reel_recraft_style_id").limit(1);
  log("COLUMNS", { readError: cols.error?.message ?? null });

  // «El Duro»: present in the ElevenLabs account, and granted to the owner's account in the env this job received.
  const key = env.ELEVENLABS_API_KEY?.trim();
  if (key) {
    const v = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
    const voices = v.ok ? ((await v.json()) as { voices: { voice_id: string; name: string; category: string }[] }).voices : [];
    const duro = voices.filter((x) => /duro/i.test(x.name));
    const cats: Record<string, number> = {};
    for (const x of voices) cats[x.category] = (cats[x.category] ?? 0) + 1;
    log("VOICES", { total: voices.length, byCategory: cats, ownClones: voices.filter((x) => x.category !== "premade").map((x) => x.name) });
    const grants = new Map<string, Set<string>>();
    for (const e of (env.PRIVATE_VOICE_GRANTS ?? "").split(";")) {
      const [id, emails] = e.split("=").map((s) => s?.trim() ?? "");
      if (id && emails) grants.set(id, new Set(emails.split("|").map((m) => m.trim().toLowerCase())));
    }
    log("EL_DURO", { voicesHttp: v.status, found: duro.length, voices: duro.map((x) => ({ name: x.name, category: x.category,
      grantedToOwnerHere: env.PRIVATE_VOICE_GRANTS ? !!(ownerEmail && grants.get(x.voice_id)?.has(ownerEmail)) : "PRIVATE_VOICE_GRANTS not provided to this job" })) });
    const sub = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": key } });
    const sj = sub.ok ? (await sub.json()) as { tier?: string; character_count?: number; character_limit?: number; next_character_count_reset_unix?: number } : null;
    log("ELEVENLABS_CREDITS", { http: sub.status, tier: sj?.tier ?? null, used: sj?.character_count ?? null, limit: sj?.character_limit ?? null,
      remaining: sj && typeof sj.character_limit === "number" && typeof sj.character_count === "number" ? sj.character_limit - sj.character_count : null,
      resetsAt: sj?.next_character_count_reset_unix ? new Date(sj.next_character_count_reset_unix * 1000).toISOString() : null });
  } else log("EL_DURO", { skipped: "ELEVENLABS_API_KEY not provided" });
}
main().catch((e) => { console.error("FAILED", e instanceof Error ? e.message : "error"); process.exit(1); });
