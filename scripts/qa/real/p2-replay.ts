/**
 * Reproducción EN SECO del reintento real de P2 (episodio fallido «FOTO»), USD 0, sin escrituras en producción.
 * Se ejecuta copiado dentro del checkout del PR (código que se desplegaría) por .github/workflows/p2-replay.yml.
 *  - Lee el episodio, el libro de operaciones y los artefactos pagados (Storage) y la foto fija del avatar.
 *  - Libro: lectura real + capa en memoria (nada se escribe). Guardia: en memoria. Sin subidas a Storage.
 *  - Voz y avatar: NUNCA se llaman (el job no recibe sus claves). Lo que se pagaría se registra y se sustituye por un
 *    marcador local para que el pipeline termine y se pueda medir el resultado.
 *  - Imágenes: búsqueda/descarga gratuita de Pexels (igual que el worker).
 * Imprime solo conteos, importes, duraciones y prefijos de clave: ninguna ruta, URL, id de cuenta ni contenido.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createServiceClient } from "@/lib/supabase/service";
import { STUDIO_TABLE, STUDIO_COLUMNS, supabaseStudioLedger } from "@/lib/podcast/v3/store";
import { StudioSpec } from "@/lib/podcast/v3/spec";
import { runEpisode } from "@/lib/podcast/v3/pipeline";
import { realTts, realAvatar, realImages } from "@/lib/podcast/v3/adapters";
import { stillSource } from "@/lib/podcast/v3/still-source";
import type { LedgerRow } from "@/lib/podcast/v3/cost";
import { searchScenePhotos } from "@/lib/ai/footage";
import { downloadToFile } from "@/lib/podcast/visual-assets";

const out = (tag: string, v: unknown) => console.log(tag, JSON.stringify(v));
const sortK = (rows: LedgerRow[]) => [...rows].sort((a, b) => a.key.localeCompare(b.key));
const short = (k: string) => k.slice(0, 8);

async function main() {
  const episode = process.env.EPISODE_ID ?? "";
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(episode)) throw new Error("EPISODE_ID");
  for (const k of ["ELEVENLABS_API_KEY", "HEYGEN_API_KEY", "ANTHROPIC_API_KEY"]) if (process.env[k]) throw new Error(`${k} presente: abortado`);
  const service = createServiceClient();
  const { data: row } = await service.from(STUDIO_TABLE).select(STUDIO_COLUMNS).eq("id", episode).single();
  if (!row) throw new Error("episodio no encontrado");
  const spec = StudioSpec.parse(row.spec);
  const owner = row.user_id as string;
  const base = `${owner}/podcast-studio/${episode}`;
  const est = (row.estimate ?? {}) as { totalUsd?: number; rates?: { voiceUsdPer1kChars?: number }; lines?: { concept: string; usd: number }[] };
  out("EPISODE", { status: row.status, error: row.error, mode: spec.mode, output: spec.output, budget_usd: spec.budget_usd, authorized_usd: row.authorized_usd, estimated_usd: row.estimated_usd, estimate_lines: est.lines ?? null, cost_usd: row.cost_usd,
    avatars: spec.participants.map((p) => ({ id: p.id, kind: p.avatar.kind })), sameAvatar: JSON.stringify(spec.participants[0]?.avatar) === JSON.stringify(spec.participants[1]?.avatar) });

  // Libro: lectura real, escrituras en memoria.
  const real = supabaseStudioLedger(service, owner);
  const before = await real.byEpisode(episode);
  const overlay = new Map<string, LedgerRow>();
  const reads: string[] = [];
  const ledger = {
    async get(key: string) { if (overlay.has(key)) return overlay.get(key); const r = await real.get(key); if (r?.state === "settled") reads.push(key); return r; },
    async put(r: LedgerRow) { overlay.set(r.key, r); },
    async byEpisode(ep: string) { const m = new Map((await real.byEpisode(ep)).map((r) => [r.key, r])); for (const [k, r] of overlay) if (r.episode === ep) m.set(k, r); return [...m.values()]; },
  };

  // Artefactos pagados: verificación de existencia, ruta esperada y duración (lectura).
  const checks = [];
  for (const r of before) {
    const ref = r.result ?? "";
    const p = ref.replace(/^storage:/, "");
    const expected = p.startsWith(`${base}/paid/${r.key.slice(0, 32)}`);
    let bytes = 0, seconds: number | null = null;
    if (ref.startsWith("storage:")) {
      const { data } = await service.storage.from("videos").download(p);
      if (data) {
        const f = path.join(os.tmpdir(), `chk-${short(r.key)}${path.extname(p)}`); const buf = Buffer.from(await data.arrayBuffer()); bytes = buf.length; await writeFile(f, buf);
        const pr = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" }); seconds = Number(pr.stdout.trim()) || null;
      }
    }
    checks.push({ key: short(r.key), provider: r.provider, op: r.op, state: r.state, usd: r.actual_usd ?? r.reserved_usd, storageRef: ref.startsWith("storage:"), expectedPath: expected, bytes, seconds });
  }
  out("PAID_ARTIFACTS", checks);

  // Proveedores: mismos nombres/modelo/tarifas que el worker (las claves del libro dependen de ellos); llamadas sustituidas.
  const rate = Number(est.rates?.voiceUsdPer1kChars);
  const rates = Number.isFinite(rate) && rate > 0 ? { voiceUsdPer1kChars: rate } : undefined;
  const tts = realTts(spec.language, rates?.voiceUsdPer1kChars);
  const wouldPay: { provider: string; op: string; seconds?: number; usdCap?: number }[] = [];
  tts.synth = async () => { wouldPay.push({ provider: "elevenlabs", op: "tts" }); throw new Error("SECO: se habría llamado a ElevenLabs"); };
  const stillReads: { bucket: string; found: boolean }[] = [];
  const avatarRow = async (id: string) => {
    const { data } = await service.from("avatars").select("provider_avatar_id,source_photo_path").eq("id", id).eq("user_id", owner).eq("status", "ready").maybeSingle();
    if (!data?.provider_avatar_id) throw new Error("AVATAR_NO_DISPONIBLE"); return data as { provider_avatar_id: string; source_photo_path: string | null };
  };
  const avatar = realAvatar({
    publishAudio: async () => { throw new Error("SECO: no se publica audio"); },
    fetchStill: async (ref, dest) => {
      const src = stillSource(owner, ref, ref.startsWith("foto:") ? null : (await avatarRow(ref)).source_photo_path);
      const { data } = await service.storage.from(src.bucket).download(src.path);
      stillReads.push({ bucket: src.bucket, found: !!data });
      if (!data) throw new Error("FOTO");
      await writeFile(dest, Buffer.from(await data.arrayBuffer()));
    },
  });
  avatar.render = async (_ref, audioFile, seconds, dest, maxUsd) => {
    wouldPay.push({ provider: "heygen", op: "avatar_clip", seconds: Math.round(seconds * 1000) / 1000, usdCap: maxUsd });
    // Marcador local (no es un clip del proveedor): fondo + audio del tramo, para que el montaje termine.
    const r = spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=gray:s=1280x720:d=${seconds.toFixed(3)}`, "-i", audioFile, "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", dest]);
    if (r.status !== 0) throw new Error("marcador");
    return { actualUsd: maxUsd };
  };
  const images = realImages({ searchPhotos: async (q) => (await searchScenePhotos(q, spec.format === "9:16" ? "portrait" : "landscape", spec.language === "en" ? "en-US" : "es-ES")).map((c) => ({ id: c.sourceId, url: c.url, credit: c.photographer, description: c.description })), download: downloadToFile });
  const local = new Map<string, string>();
  const artifacts = {
    async put(key: string, file: string) { const ref = `storage:${base}/paid/${key.slice(0, 32)}${path.extname(file) || ".bin"}`; local.set(ref, file); return ref; },
    async get(ref: string, dest: string) {
      const p = ref.replace(/^storage:/, "");
      if (!ref.startsWith("storage:") || !p.startsWith(`${base}/paid/`)) throw new Error("ARTEFACTO_AJENO");
      const { data } = await service.storage.from("videos").download(p); if (!data) throw new Error("ARTEFACTO_NO_ENCONTRADO");
      await writeFile(dest, Buffer.from(await data.arrayBuffer()));
    },
  };
  const guard = { acquire: async () => true, release: async () => {} };

  const run = async (label: string, authorizedUsd: number) => {
    wouldPay.length = 0; overlay.clear(); reads.length = 0;
    const dir = path.join(os.tmpdir(), "p2replay", label); await mkdir(dir, { recursive: true });
    try {
      const r = await runEpisode(spec, { owner, episode, dir, providers: { tts, avatar, images } as never, ledger, guard: guard as never, authorizedUsd, artifacts, rates });
      const probe = (f: string) => JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", f], { encoding: "utf8" }).stdout || "{}");
      const v = r.mp4 ? probe(r.mp4) : null, a = probe(r.audio);
      const decode = r.mp4 ? spawnSync("ffmpeg", ["-v", "error", "-i", r.mp4, "-f", "null", "-"]).status : null;
      const res = { authorizedUsd, ok: r.ok, reusedOps: r.reusedOps, newOps: r.paidOps, reusedKeys: [...new Set(reads)].map(short), wouldPay, wouldPayUsdCap: Math.round(wouldPay.reduce((n, x) => n + (x.usdCap ?? 0), 0) * 1e4) / 1e4,
        projectedEpisodeUsd: r.spentUsd, mp4: v ? { streams: (v.streams ?? []).map((s: { codec_type: string }) => s.codec_type), seconds: Number(v.format?.duration) } : null, mp4DecodeStatus: decode, audioSeconds: Number(a.format?.duration), stillReads };
      out(`RUN_${label}`, res); return res;
    } catch (e) {
      const res = { authorizedUsd, failed: e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 300) : "error", reusedKeys: [...new Set(reads)].map(short), wouldPay, stillReads };
      out(`RUN_${label}`, res); return res;
    }
  };
  const results: Record<string, unknown>[] = [];
  for (const amount of (process.env.AMOUNTS ?? "0.5,1").split(",").map(Number).filter((n) => n > 0)) results.push(await run(String(amount).replace(".", "_"), amount) as Record<string, unknown>);
  const after = await real.byEpisode(episode);
  const unchanged = JSON.stringify(sortK(before)) === JSON.stringify(sortK(after));
  out("LEDGER_UNCHANGED", { before: before.length, after: after.length, identical: unchanged });
  // Puerta previa al reintento real (GATE=1): cualquier desviación → no se cobra nada (el job falla).
  if (process.env.GATE === "1") {
    const maxInc = Number(process.env.MAX_INCREMENTAL_USD);
    const settled = before.filter((r) => r.state === "settled");
    const last = results[results.length - 1] ?? {};
    const pays = (last.wouldPay as { provider: string; op: string }[] | undefined) ?? [];
    const reused = new Set((last.reusedKeys as string[] | undefined) ?? []);
    const conditions = {
      episodeFailed: row.status === "failed",
      noReservedOrUncertain: before.every((r) => r.state === "settled" || r.state === "released"),
      nineSettled: settled.length === 9,
      artifactsPresent: checks.every((c) => c.storageRef && c.expectedPath && c.bytes > 0 && (c.seconds ?? 0) > 0),
      everyPaidKeyReused: settled.every((r) => reused.has(short(r.key))) && last.reusedOps === settled.length,
      zeroNewVoices: pays.every((x) => x.op !== "tts"),
      onlyThreeNewClips: pays.length === 3 && pays.every((x) => x.provider === "heygen" && x.op === "avatar_clip"),
      incrementalWithinLimit: Number.isFinite(maxInc) && Number(last.wouldPayUsdCap) <= maxInc + 1e-9,
      authorizationCapsIncremental: Number.isFinite(maxInc) && Number(last.authorizedUsd) - settled.reduce((n, r) => n + Number(r.actual_usd ?? r.reserved_usd), 0) <= maxInc + 1e-9,
      stillFound: ((last.stillReads as { found: boolean }[] | undefined) ?? []).some((x) => x.found),
      endsOk: last.ok === true && last.mp4DecodeStatus === 0,
      ledgerUnchanged: unchanged,
    };
    const pass = Object.values(conditions).every(Boolean);
    out("GATE", { pass, conditions });
    if (!pass) process.exitCode = 1;
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : "error"); process.exitCode = 1; });
