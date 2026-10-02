/**
 * ATOMIVID_PRECAMPAIGN_TEASER_V1 — descubrimiento SIN GASTO (solo lectura).
 *
 * Comprueba, antes de cualquier llamada pagada, qué existe ya para el teaser:
 * - los dos clips reales de Hans (HANS_OPENING_REAL / HANS_CLOSING_REAL), subidos por un
 *   humano al bucket privado "videos" ya existente: formato real con ffprobe (1080x1920, 30 fps,
 *   audio);
 * - el avatar y la voz clonada indicados explícitamente por id (nunca se busca por usuario ni
 *   email: el operador elige cuáles están autorizados);
 * - assets reutilizables ya renderizados (rutas en el mismo bucket).
 *
 * Solo usa Supabase (lectura). Ningún proveedor pagado: el workflow no le pasa claves de
 * ElevenLabs, HeyGen, D-ID, OpenAI, Runway ni Beatoven. No escribe nada.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { mkdir } from "node:fs/promises";

export {};

const BUCKET = "videos";
const EXPECTED = { width: 1080, height: 1920, fps: 30 };
const FPS_TOLERANCE = 0.5;

type ClipStatus = { path: string | null; status: "READY" | "MISSING_FROM_WORKFLOW" | "INVALID"; detail?: string; width?: number; height?: number; fps?: number; durationSeconds?: number; hasAudio?: boolean };

async function probe(file: string) {
  const { stdout } = await promisify(execFile)(ffprobeInstaller.path, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  const json = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number; avg_frame_rate?: string }[] };
  const video = json.streams?.find((s) => s.codec_type === "video");
  const [n, d] = (video?.avg_frame_rate ?? "0/1").split("/").map(Number);
  return {
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: d ? Math.round((n / d) * 1000) / 1000 : 0,
    durationSeconds: Number(json.format?.duration ?? 0),
    hasAudio: Boolean(json.streams?.some((s) => s.codec_type === "audio")),
  };
}

async function main() {
  const { createServiceClient } = await import("../../src/lib/supabase/service");
  const service = createServiceClient();
  const bucket = service.storage.from(BUCKET);
  const work = await mkdtemp(join(tmpdir(), "teaser-discover-"));

  const clip = async (path: string | undefined): Promise<ClipStatus> => {
    if (!path?.trim()) return { path: null, status: "MISSING_FROM_WORKFLOW", detail: "no se indicó la ruta en Storage" };
    const { data, error } = await bucket.download(path.trim());
    if (error || !data) return { path, status: "MISSING_FROM_WORKFLOW", detail: `no existe en el bucket "${BUCKET}"` };
    const bytes = Buffer.from(await data.arrayBuffer());
    if (bytes.byteLength === 0) return { path, status: "INVALID", detail: "archivo vacío" };
    const file = join(work, `clip-${Math.random().toString(36).slice(2)}.mp4`);
    await writeFile(file, bytes);
    const m = await probe(file).catch(() => null);
    if (!m) return { path, status: "INVALID", detail: "ffprobe no pudo leer el archivo" };
    const problems = [
      m.width !== EXPECTED.width || m.height !== EXPECTED.height ? `resolución ${m.width}x${m.height}` : "",
      Math.abs(m.fps - EXPECTED.fps) > FPS_TOLERANCE ? `fps ${m.fps}` : "",
      m.hasAudio ? "" : "sin pista de audio",
    ].filter(Boolean);
    return { path, status: problems.length ? "INVALID" : "READY", detail: problems.join("; ") || undefined, ...m };
  };

  const avatarId = process.env.TEASER_AVATAR_ID?.trim();
  const voiceId = process.env.TEASER_VOICE_ID?.trim();
  const avatar = avatarId
    ? await service.from("avatars").select("id,provider,status,consent_given,provider_avatar_id").eq("id", avatarId).maybeSingle()
    : null;
  const voice = voiceId
    ? await service.from("user_voices").select("id,provider,status,provider_voice_id").eq("id", voiceId).maybeSingle()
    : null;

  // Identidades existentes (sin usuario fijo): solo metadatos no sensibles de avatares y voces listos,
  // para que el operador elija el avatar y la voz autorizados de Hans. Nunca se crean.
  const identities = process.env.TEASER_LIST_IDENTITIES === "true"
    ? {
        avatars: (await service.from("avatars").select("id,name,provider,status,created_at").eq("status", "ready").order("created_at", { ascending: false }).limit(20)).data ?? [],
        voices: (await service.from("user_voices").select("id,name,provider,status,created_at").eq("status", "ready").order("created_at", { ascending: false }).limit(20)).data ?? [],
      }
    : undefined;

  // Prefijos reutilizables (renders ya entregados): nombres y tamaños, dos niveles, sin descargar.
  const listing: Record<string, { path: string; bytes: number | null }[]> = {};
  for (const prefix of (process.env.TEASER_REUSE_PREFIXES ?? "").split(",").map((p) => p.trim().replace(/\/+$/, "")).filter(Boolean)) {
    const found: { path: string; bytes: number | null }[] = [];
    const walk = async (dir: string, depth: number) => {
      const { data } = await bucket.list(dir, { limit: 100 });
      for (const e of data ?? []) {
        const full = `${dir}/${e.name}`;
        if (e.id === null) { if (depth < 2) await walk(full, depth + 1); }
        else found.push({ path: full, bytes: (e.metadata as { size?: number } | null)?.size ?? null });
      }
    };
    await walk(prefix, 0);
    listing[prefix] = found.slice(0, 60);
  }

  // Clips subidos por el operador: cada MP4 del prefijo con ffprobe y dos fotogramas de referencia
  // (para identificar visualmente la toma con lentes / sin lentes). Sin proveedores.
  const outDir = "teaser-discovery";
  await mkdir(join(outDir, "frames"), { recursive: true });
  await mkdir(join(outDir, "avatars"), { recursive: true });
  const probed: Record<string, unknown>[] = [];
  const probePrefix = process.env.TEASER_PROBE_PREFIX?.trim().replace(/\/+$/, "");
  if (probePrefix) {
    const { data } = await bucket.list(probePrefix, { limit: 100 });
    for (const e of (data ?? []).filter((x) => x.id !== null && /\.(mp4|mov|m4v)$/i.test(x.name))) {
      const path = `${probePrefix}/${e.name}`;
      const status = await clip(path);
      const local = join(work, `probe-${e.name}`);
      const dl = await bucket.download(path);
      if (dl.data) {
        await writeFile(local, Buffer.from(await dl.data.arrayBuffer()));
        for (const at of [0.5, Math.max(1, (status.durationSeconds ?? 2) / 2)]) {
          await promisify(execFile)(ffmpegInstaller.path, ["-v", "error", "-ss", String(at), "-i", local, "-frames:v", "1", "-vf", "scale=360:-2", "-y", join(outDir, "frames", `${e.name}-${at.toFixed(1)}s.jpg`)]).catch(() => undefined);
        }
      }
      probed.push({ name: e.name, createdAt: e.created_at, bytes: (e.metadata as { size?: number } | null)?.size ?? null, ...status });
    }
  }

  // Foto de origen ya guardada de los avatares indicados (referencia visual sin gasto; nunca se llama
  // al proveedor). Solo para la revisión del operador; el artifact caduca pronto.
  const avatarPhotos: Record<string, unknown>[] = [];
  for (const id of (process.env.TEASER_AVATAR_PHOTO_IDS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const { data: row } = await service.from("avatars").select("id,name,provider,source_photo_path,source_deleted_at").eq("id", id).maybeSingle();
    if (!row?.source_photo_path || row.source_deleted_at) {
      avatarPhotos.push({ id, photo: "NOT_AVAILABLE" });
      continue;
    }
    const dl = await service.storage.from("avatar-uploads").download(row.source_photo_path);
    if (!dl.data) {
      avatarPhotos.push({ id, photo: "NOT_AVAILABLE" });
      continue;
    }
    const ext = row.source_photo_path.split(".").pop() ?? "jpg";
    await writeFile(join(outDir, "avatars", `${id}.${ext}`), Buffer.from(await dl.data.arrayBuffer()));
    avatarPhotos.push({ id, name: row.name, provider: row.provider, photo: `avatars/${id}.${ext}` });
  }

  // Búsqueda por nombre en la raíz de todos los buckets (y un nivel dentro de lo que coincida):
  // para localizar subidas del operador sin conocer la ruta exacta. Solo nombres y tamaños.
  const found: Record<string, { path: string; bytes: number | null }[]> = {};
  const needle = process.env.TEASER_FIND_NAME?.trim().toLowerCase();
  if (needle) {
    const { data: buckets } = await service.storage.listBuckets();
    for (const b of buckets ?? []) {
      const store = service.storage.from(b.name);
      const hits: { path: string; bytes: number | null }[] = [];
      const { data: root } = await store.list("", { limit: 1000 });
      for (const e of root ?? []) {
        if (!e.name.toLowerCase().includes(needle)) continue;
        if (e.id !== null) { hits.push({ path: e.name, bytes: (e.metadata as { size?: number } | null)?.size ?? null }); continue; }
        const { data: inner } = await store.list(e.name, { limit: 100 });
        for (const f of inner ?? []) hits.push({ path: `${e.name}/${f.name}`, bytes: (f.metadata as { size?: number } | null)?.size ?? null });
      }
      found[b.name] = hits;
    }
  }

  const reuse = [];
  for (const path of (process.env.TEASER_REUSE_PATHS ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const name = path.slice(path.lastIndexOf("/") + 1);
    const { data } = await bucket.list(dir, { search: name });
    const hit = data?.find((e) => e.name === name);
    reuse.push({ path, exists: Boolean(hit), bytes: (hit?.metadata as { size?: number } | null)?.size ?? null });
  }

  const report = {
    teaser: "ATOMIVID_PRECAMPAIGN_TEASER_V1",
    providerCalls: 0,
    spendUsd: 0,
    inputs: { HANS_OPENING_REAL: await clip(process.env.TEASER_OPENING_PATH), HANS_CLOSING_REAL: await clip(process.env.TEASER_CLOSING_PATH) },
    avatar: avatarId
      ? avatar?.data
        ? { id: avatar.data.id, provider: avatar.data.provider, status: avatar.data.status, consentGiven: avatar.data.consent_given, hasProviderAvatar: Boolean(avatar.data.provider_avatar_id) }
        : { id: avatarId, status: "NOT_FOUND" }
      : { status: "NOT_PROVIDED" },
    voice: voiceId
      ? voice?.data
        ? { id: voice.data.id, provider: voice.data.provider, status: voice.data.status, hasProviderVoice: Boolean(voice.data.provider_voice_id) }
        : { id: voiceId, status: "NOT_FOUND" }
      : { status: "NOT_PROVIDED" },
    reuse,
    identities,
    listing,
    probed,
    avatarPhotos,
    found,
  };
  await rm(work, { recursive: true, force: true });
  await writeFile(join(outDir, "teaser-discovery.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error("Descubrimiento del teaser fallido:", err instanceof Error ? err.message : err);
  process.exit(1);
});
