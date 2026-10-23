/** Read-only: find which ElevenLabs voice narrated Thermopylae (video-004). DB + Storage only; no provider call. */
import { createClient } from "@supabase/supabase-js";
const log = (t: string, v: unknown) => console.log(t, JSON.stringify(v));
async function main() {
  const db = createClient(process.env.SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: ops } = await db.from("pi_paid_operations").select("project_id,shot_id,method,status,created_at,result_ref").eq("provider", "elevenlabs").or("project_id.ilike.%thermop%,project_id.ilike.%video-004%,shot_id.ilike.%thermop%").limit(20);
  log("DIAG_TTS_OPS", (ops ?? []).map((o: any) => ({ p: String(o.project_id).slice(0, 40), s: String(o.shot_id).slice(0, 60), m: o.method, st: o.status, at: o.created_at, ref: String(o.result_ref ?? "").slice(0, 80) })));
  const voices = new Map<string, number>();
  const scan = async (prefix: string, depth: number) => {
    const { data } = await db.storage.from("videos").list(prefix, { limit: 200 });
    for (const it of data ?? []) {
      const path = prefix ? `${prefix}/${it.name}` : it.name;
      if (!it.id && depth < 3) { await scan(path, depth + 1); continue; }
      if (/\.(json|txt|md)$/i.test(it.name) && (it.metadata?.size ?? 0) < 3_000_000) {
        const f = await db.storage.from("videos").download(path); if (!f.data) continue;
        const t = await f.data.text();
        for (const m of t.matchAll(/"(?:voice_?[iI]d|voiceId|voice)"\s*:\s*"([A-Za-z0-9]{16,32})"/g)) voices.set(`${m[1]}@${path}`, (voices.get(`${m[1]}@${path}`) ?? 0) + 1);
      }
    }
  };
  await scan("video-004-thermopylae", 0);
  log("DIAG_VOICES", [...voices].slice(0, 20));
}
main().catch(e => { console.error("FAILED", String(e).slice(0, 200)); process.exitCode = 1; });
