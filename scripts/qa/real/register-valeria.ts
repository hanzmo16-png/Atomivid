/**
 * Registra a Valeria Montclair como avatar de Atomivid en la cuenta de Hans, REUTILIZANDO lo que ya existe (USD 0):
 * - imagen: el asset de HeyGen dcf70e13… (creado el 24-oct desde opt-v1, SHA-256 d1eb3a83…, maestro v1 de Drive);
 *   se descarga tal como lo sirve HeyGen (re-codificado) y se exigen las medidas de opt-v1 antes de guardar nada;
 * - fila avatars: provider heygen, provider_avatar_id «asset:dcf70e13…» (formato de src/lib/providers/avatar/heygen.ts),
 *   source_photo_path en avatar-uploads/<owner>/ (lo que lee stillSource para los planos de escucha).
 * Consentimiento: el registrado es el del titular de la cuenta (Hans), que aportó la imagen como copresentadora virtual
 * y aprobó su uso, voz (Callie) y guion el 24-oct-2026 (registro valeria-montclair-avatar-master-v1.md). No existe —ni
 * se inventa— una cesión de un tercero. Idempotente: si ya existe la fila, solo la muestra.
 * MODO=dry (por defecto) no escribe; MODO=apply escribe.
 */
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const ASSET = "dcf70e13d7b44cd2ad95836412120ab4";
const SHA = "d1eb3a8361a7d833fabf46697a5b0d90dd62aabf4d1bb8ff538a08b268861e8a";
const OWNER_EMAIL_SHA256 = "8dcc0bfc5e69efb6c156c7972579693e10c2ff3c72ca363fc6d1fb79d58fdaac"; // misma identificación que studio-resources.ts
const out = (t: string, v: unknown) => console.log(t, JSON.stringify(v));
async function main() {
  const apply = process.env.MODO === "apply";
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  let owner = "";
  for (let page = 1; page <= 50 && !owner; page++) {
    const { data } = await db.auth.admin.listUsers({ page, perPage: 200 });
    const hit = data?.users.find((u) => u.email && createHash("sha256").update(u.email.trim().toLowerCase()).digest("hex") === OWNER_EMAIL_SHA256);
    if (hit) owner = hit.id;
    if (!data?.users.length) break;
  }
  if (!owner) throw new Error("no se encontró la cuenta de Hans");
  const { data: av, error } = await db.from("avatars").select("id,user_id,name,provider,provider_avatar_id,source_photo_path,status,consent_given,consent_policy_version").eq("user_id", owner);
  if (error) throw new Error(`avatars: ${error.message}`);
  const shape = (a: Record<string, unknown>) => ({ id: a.id, name: a.name, ref: String(a.provider_avatar_id ?? "").replace(/^(asset:).{6}.*/, "$1…"), photoInOwnerFolder: String(a.source_photo_path ?? "").startsWith(`${owner}/`), status: a.status, consent: a.consent_given, policy: a.consent_policy_version });
  out("OWNER_AVATARS", (av ?? []).filter((a) => a.user_id === owner).map(shape));
  const existing = (av ?? []).find((a) => a.user_id === owner && a.provider_avatar_id === `asset:${ASSET}`);
  if (existing) { out("VALERIA_EXISTS", shape(existing)); return; }
  const r = await fetch(`https://api.heygen.com/v3/assets/${ASSET}`, { headers: { "X-Api-Key": process.env.HEYGEN_API_KEY ?? "" } });
  const j = (await r.json().catch(() => null)) as Record<string, unknown> | null;
  const d = ((j?.data ?? j) ?? {}) as Record<string, unknown>;
  const url = ["url", "image_url", "download_url", "file_url"].map((k) => d[k]).find((v): v is string => typeof v === "string" && /^https:/.test(v))
    ?? Object.values(d).find((v): v is string => typeof v === "string" && /^https:/.test(v));
  if (!r.ok || !url) throw new Error(`asset HeyGen sin URL descargable (http ${r.status})`);
  const img = Buffer.from(await (await fetch(url)).arrayBuffer());
  const sha = createHash("sha256").update(img).digest("hex");
  // HeyGen sirve el asset re-codificado (los bytes ya no son los de opt-v1, 2026-10-28): la identidad la fija el id del
  // asset documentado en el registro maestro; se exige además que el archivo sea una imagen de las medidas de opt-v1.
  const sharp = (await import("sharp")).default;
  const meta = await sharp(img).metadata();
  const ext = meta.format === "jpeg" ? "jpg" : meta.format;
  const sameSize = meta.width === 1218 && meta.height === 1326;
  out("ASSET_IMAGE", { bytes: img.length, format: meta.format, width: meta.width, height: meta.height, sha256: sha, bytesEqualOptV1: sha === SHA, sizeEqualOptV1: sameSize });
  if (!sameSize || !["jpeg", "png", "webp"].includes(String(meta.format))) throw new Error("el asset no tiene las medidas de opt-v1 (1218x1326): no se registra nada");
  const path = `${owner}/valeria-montclair-heygen-asset-${ASSET.slice(0, 8)}.${ext}`;
  const row = { user_id: owner, name: "Valeria Montclair", provider: "heygen", provider_avatar_id: `asset:${ASSET}`, source_photo_path: path,
    status: "ready", consent_given: true, consent_given_at: "2026-10-24T20:00:00Z", consent_policy_version: "2026-09-17" };
  out("PLAN", { apply, path: path.replace(owner, "<owner>"), row: { ...row, user_id: "<owner>", source_photo_path: path.replace(owner, "<owner>") } });
  if (!apply) return;
  const up = await db.storage.from("avatar-uploads").upload(path, img, { contentType: `image/${meta.format}`, upsert: false });
  if (up.error && !/exist|duplicate/i.test(up.error.message)) throw new Error(`storage: ${up.error.message}`);
  if (up.error) { // ya estaba: debe ser exactamente la misma imagen
    const { data: blob } = await db.storage.from("avatar-uploads").download(path);
    const prev = blob ? createHash("sha256").update(Buffer.from(await blob.arrayBuffer())).digest("hex") : null;
    if (prev !== sha) throw new Error("ya existe otro archivo en esa ruta: no se sobrescribe");
  }
  const ins = await db.from("avatars").insert(row).select("id,user_id,name,provider,provider_avatar_id,source_photo_path,status,consent_given,consent_policy_version").single();
  if (ins.error) throw new Error(`insert: ${ins.error.message}`);
  out("VALERIA_REGISTERED", shape(ins.data));
}
main().catch((e) => { console.error(e instanceof Error ? e.message : "error"); process.exitCode = 1; });
