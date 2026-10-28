// Read-only (USD 0): copies the paid avatar clips, the mastered audio and the participants' stills of a finished studio
// episode into $EVID (encrypted by the workflow) so the new shared-studio composition can be developed on the real
// material without paying for new clips. Also reports the supply policies relevant to Recraft/Anthropic (read-only).
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const EVID = process.env.EVID, ID = process.env.POD_EPISODE_ID || "";
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const out = (t, v) => console.log(t, JSON.stringify(v));
fs.mkdirSync(path.join(EVID, "clips"), { recursive: true });
const { data: pol } = await db.from("pi_supply_policies").select("provider,enabled,unit,daily_cap_usd,monthly_cap_usd,max_daily_calls").in("provider", ["recraft", "anthropic", "elevenlabs", "heygen", "__global__"]);
out("POLICIES", pol ?? []);
for (const p of ["recraft", "anthropic"]) { const { data, error } = await db.rpc("pi_supply_state", { p_provider: p }); out("STATE", { p, level: data?.level ?? null, reason: data?.reason ?? null, free: data?.free ?? null, error: error?.message ?? null }); }
const { data: ep } = await db.from("podcast_studio_episodes").select("user_id,spec,result,audio_path").eq("id", ID).single();
const { data: ops } = await db.from("podcast_studio_operations").select("op,result,actual_usd,created_at").eq("episode_id", ID).eq("op", "avatar_clip").eq("state", "settled").order("created_at");
let n = 0;
for (const o of ops ?? []) {
  const p = String(o.result ?? "").replace(/^storage:/, "");
  const { data } = await db.storage.from("videos").download(p);
  if (data) { fs.writeFileSync(path.join(EVID, "clips", `${String(++n).padStart(2, "0")}-${path.basename(p)}`), Buffer.from(await data.arrayBuffer())); }
}
out("CLIPS", { settled: ops?.length ?? 0, copied: n });
if (ep?.audio_path) { const { data } = await db.storage.from("videos").download(ep.audio_path); if (data) fs.writeFileSync(path.join(EVID, "episodio.mp3"), Buffer.from(await data.arrayBuffer())); }
fs.writeFileSync(path.join(EVID, "result.json"), JSON.stringify({ result: ep?.result, participants: ep?.spec?.participants?.map((x) => ({ id: x.id, name: x.name, avatar: x.avatar })), visual: ep?.spec?.visual, clipOps: (ops ?? []).map((o) => ({ at: o.created_at, usd: o.actual_usd, file: path.basename(String(o.result ?? "")) })) }, null, 1));
