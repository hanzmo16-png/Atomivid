/**
 * Recursos para una prueba con DOS identidades (USD 0, solo lectura): avatares del dueño (estado, proveedor, foto fija y
 * consentimiento; ids con hash) y voces de la cuenta de ElevenLabs (GET de listado). Sin nombres de personas: las voces
 * privadas/clonadas se muestran solo por categoría y hash; las prediseñadas, por su nombre público.
 */
import { createHash } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/service";
import { listAccountVoices } from "@/lib/podcast/voices";

const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8);
const out = (t: string, v: unknown) => console.log(t, JSON.stringify(v));
async function main() {
  const service = createServiceClient();
  // Dueño por el sha256 de su correo (mismo criterio que session.mjs; ningún correo en el repositorio).
  const OWNER_EMAIL_SHA256 = "8dcc0bfc5e69efb6c156c7972579693e10c2ff3c72ca363fc6d1fb79d58fdaac";
  let owner = "";
  for (let page = 1; page <= 50 && !owner; page++) {
    const { data } = await service.auth.admin.listUsers({ page, perPage: 200 });
    const hit = data?.users.find((u) => u.email && createHash("sha256").update(u.email.trim().toLowerCase()).digest("hex") === OWNER_EMAIL_SHA256);
    if (hit) owner = hit.id;
    if (!data?.users.length) break;
  }
  if (!owner) throw new Error("owner not found");
  const { data: avatars } = await service.from("avatars").select("id,provider,provider_avatar_id,source_photo_path,status,consent_given,created_at").eq("user_id", owner).order("created_at");
  const rows = [];
  for (const a of avatars ?? []) {
    const p = a.source_photo_path as string | null;
    const inUploads = p ? !!(await service.storage.from("avatar-uploads").download(p)).data : false;
    rows.push({ id: h(a.id), provider: a.provider, hasProviderAvatar: !!a.provider_avatar_id, providerIdSame: null as boolean | null, status: a.status, consent: a.consent_given, hasPhoto: !!p, photoInAvatarUploads: inUploads, created: a.created_at, pid: a.provider_avatar_id ? h(a.provider_avatar_id) : null });
  }
  out("AVATARS", { total: rows.length, ready: rows.filter((r) => r.status === "ready" && r.hasProviderAvatar).length, distinctProviderAvatars: new Set(rows.filter((r) => r.pid).map((r) => r.pid)).size, rows });
  const { data: photos } = await service.storage.from("videos").list(`${owner}/podcast-studio/photos`, { limit: 100 });
  out("WIZARD_PHOTOS", { count: (photos ?? []).filter((f) => f.name && !f.name.startsWith(".")).length });
  const voices = await listAccountVoices({ fresh: true });
  out("VOICES", voices.map((v) => ({ v: v.category === "premade" ? v.name : `privada#${h(v.voiceId)}`, category: v.category, language: v.language, gender: v.gender, accent: v.accent })));
  const { data: ep } = await service.from("podcast_studio_episodes").select("spec").eq("id", "0de4b445-d6d3-4f05-a0f1-62f60d2126ba").maybeSingle();
  const parts = ((ep?.spec as { participants?: { id: string; voice_id: string; avatar: { kind: string; avatar_id?: string } }[] } | null)?.participants ?? []);
  out("P2_PARTICIPANTS", parts.map((p) => ({ id: p.id, voice: h(p.voice_id), avatar: p.avatar.kind === "existente" ? h(p.avatar.avatar_id ?? "") : p.avatar.kind })));
}
main().catch((e) => { console.error(e instanceof Error ? e.message : "error"); process.exitCode = 1; });
