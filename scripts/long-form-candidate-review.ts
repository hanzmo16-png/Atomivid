/**
 * Revisión de CANDIDATOS visuales para una producción Long Form (calidad
 * M2). Genérico: recibe una solicitud y un archivo de búsquedas por pasaje.
 * Solo búsquedas gratuitas (Pexels con la clave existente; Wikimedia
 * Commons sin credenciales, SOLO dominio público) y lectura de Storage.
 * Nunca escribe en la base de datos ni en Storage; no llama a proveedores
 * de pago.
 *
 * Emite hojas de contacto (scripts/lib/contact-sheet.ts) y una línea
 * `@@CAND {...}` por candidato con su procedencia, para que la aprobación
 * sea VISUAL — la coincidencia de palabras clave solo encuentra candidatos.
 *
 * PART:
 *   words     tiempos reales por palabra de la narración guardada (≤ WINDOW_SEC)
 *   existing  miniaturas de TODOS los recursos ya guardados de la solicitud
 *   pexels    búsquedas Pexels (video + foto, horizontal) del archivo de búsquedas
 *   commons   búsquedas Wikimedia Commons (solo dominio público)
 *   detail    fotogramas grandes de candidatos concretos (DETAIL_REFS)
 */
export {};

type Cand = {
  ref: string;
  source: "pexels-video" | "pexels-photo" | "commons" | "existing";
  query?: string;
  scene?: string;
  title?: string;
  author?: string;
  license?: string;
  pageUrl?: string;
  date?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  thumbs: string[];
};

const UA = "AtomividQualityReview/1.0 (https://github.com/hanzmo16-png/Atomivid; hanzmo16-png)";
const stripHtml = (s: string | undefined) => (s ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`GET ${res.status} ${url.slice(0, 80)}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { buildContactSheet, emitSheet, frameAt, probeDuration } = await import("./lib/contact-sheet");
  const part = process.env.PART ?? "words";
  const requestId = process.env.REQUEST_ID;
  if (!requestId) throw new Error("REQUEST_ID requerido");
  for (const key of ["ELEVENLABS_API_KEY", "OPENAI_API_KEY", "VEO_API_KEY", "ANTHROPIC_API_KEY"]) {
    if (process.env[key]) throw new Error(`${key} presente — la revisión corre sin credenciales de proveedores de pago.`);
  }
  const specPath = process.env.SEARCH_SPEC ?? "docs/quality/m2-panama-opening/search-spec.json";
  const spec = JSON.parse(await fs.readFile(specPath, "utf8")) as {
    scenes: { id: string; passage: string; pexels: string[]; commons: string[] }[];
  };
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "atomivid-review-"));

  const emitCandidates = async (name: string, title: string, cands: Cand[]) => {
    const tiles = [];
    for (const [i, c] of cands.entries()) {
      for (const [k, t] of c.thumbs.entries()) {
        const image = await fetchBuffer(t).catch(() => null);
        if (!image) continue;
        const dur = c.durationSeconds ? ` ${Math.round(c.durationSeconds)}s` : "";
        tiles.push({ image, label: `#${i}${c.thumbs.length > 1 ? `.${k}` : ""} ${c.ref}${dur} | ${c.title ?? ""}` });
      }
      console.log(`@@CAND ${JSON.stringify({ n: i, sheet: name, ...c, thumbs: undefined })}`);
    }
    if (tiles.length > 0) emitSheet(name, await buildContactSheet(tiles, { columns: 5, tileWidth: 256, tileHeight: 144, title }));
  };

  if (part === "words") {
    const { createServiceClient } = await import("../src/lib/supabase/service");
    const { loadProductionCachedBeatNarration } = await import("../src/lib/video/long-form/production-tts-cache");
    const { getVoiceIdentity } = await import("../src/lib/ai/voice");
    const service = createServiceClient();
    const { data: row, error } = await service.from("video_requests").select("language,script_json").eq("id", requestId).single();
    if (error || !row) throw new Error(`request_read_failed: ${error?.message}`);
    const script = row.script_json as { beats: { id: string; narration: string }[] };
    const language = ((row.language as "es" | "en" | null) ?? "es") as "es" | "en";
    const windowSec = Number(process.env.WINDOW_SEC ?? 60);
    let cursor = 0;
    for (const beat of script.beats) {
      if (cursor >= windowSec) break;
      const narrated = await loadProductionCachedBeatNarration(service, "elevenlabs", beat, language, {
        videoId: requestId,
        voiceIdentity: getVoiceIdentity(language),
      });
      console.log(`@@BEAT ${JSON.stringify({ id: beat.id, startSec: cursor, durationSeconds: narrated.durationSeconds, narration: beat.narration })}`);
      console.log(
        `@@WORDS ${beat.id} ${JSON.stringify(narrated.words.map((w) => [w.text, +(cursor + w.startSeconds).toFixed(3), +(cursor + w.endSeconds).toFixed(3)]))}`,
      );
      cursor += narrated.durationSeconds;
    }
    return;
  }

  if (part === "existing") {
    const { createServiceClient } = await import("../src/lib/supabase/service");
    const { sha256Hex } = await import("../src/lib/video/long-form/asset-identity");
    const service = createServiceClient();
    const { data: objects, error } = await service.storage.from("videos").list(`${requestId}/assets`, { limit: 500 });
    if (error) throw new Error(error.message);
    const seen = new Map<string, string[]>();
    const tiles: { image: Buffer; label: string }[] = [];
    const sorted = (objects ?? []).map((o) => o.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const name of sorted) {
      const objectPath = `${requestId}/assets/${name}`;
      const { data } = await service.storage.from("videos").download(objectPath);
      if (!data) continue;
      const buffer = Buffer.from(await data.arrayBuffer());
      const sha = sha256Hex(buffer).slice(0, 10);
      if (seen.has(sha)) {
        seen.get(sha)!.push(name);
        continue;
      }
      seen.set(sha, [name]);
      const shot = name.replace(/\.(stock|ai_image|ai_video)\..*$/, "");
      if (/\.mp4$/.test(name)) {
        const file = path.join(tmp, `${sha}.mp4`);
        await fs.writeFile(file, buffer);
        const duration = await probeDuration(file).catch(() => 0);
        for (const f of [0.1, 0.5, 0.9]) {
          const image = await frameAt(file, Math.max(0, duration * f), 320).catch(() => null);
          if (image) tiles.push({ image, label: `${shot} VIDEO ${Math.round(duration)}s @${Math.round(duration * f)}s | ${sha}` });
        }
      } else {
        tiles.push({ image: buffer, label: `${shot} ${name.split(".").slice(-2).join(".")} | ${sha}` });
      }
    }
    for (const [sha, names] of seen) console.log(`@@EXISTING ${JSON.stringify({ sha, objects: names })}`);
    for (let i = 0; i < tiles.length; i += 20) {
      emitSheet(`existing-${i / 20 + 1}`, await buildContactSheet(tiles.slice(i, i + 20), { columns: 5, tileWidth: 256, tileHeight: 144, title: `Recursos ya guardados (${i + 1}-${Math.min(tiles.length, i + 20)} de ${tiles.length} miniaturas)` }));
    }
    return;
  }

  if (part === "pexels") {
    const key = process.env.PEXELS_API_KEY;
    if (!key) throw new Error("PEXELS_API_KEY requerido para PART=pexels");
    for (const scene of spec.scenes) {
      for (const [qi, query] of scene.pexels.entries()) {
        const cands: Cand[] = [];
        const v = await fetch(`https://api.pexels.com/videos/search?${new URLSearchParams({ query, orientation: "landscape", per_page: "10" })}`, { headers: { Authorization: key } });
        if (!v.ok) throw new Error(`Pexels videos ${v.status}`);
        const vids = (await v.json()) as { videos: { id: number; width: number; height: number; duration: number; url: string; image: string; user?: { name?: string }; video_pictures?: { picture: string; nr: number }[] }[] };
        for (const video of vids.videos) {
          const pics = video.video_pictures ?? [];
          cands.push({
            ref: `pexels-video:${video.id}`, source: "pexels-video", query, scene: scene.id,
            title: video.url.split("/").filter(Boolean).pop()?.replace(/-\d+$/, "").replace(/-/g, " "),
            author: video.user?.name, license: "Pexels License", pageUrl: video.url,
            width: video.width, height: video.height, durationSeconds: video.duration,
            thumbs: [pics[Math.floor(pics.length / 2)]?.picture ?? video.image],
          });
        }
        const p = await fetch(`https://api.pexels.com/v1/search?${new URLSearchParams({ query, orientation: "landscape", per_page: "8" })}`, { headers: { Authorization: key } });
        if (!p.ok) throw new Error(`Pexels photos ${p.status}`);
        const photos = (await p.json()) as { photos: { id: number; width: number; height: number; url: string; alt?: string; photographer: string; src: { medium: string } }[] };
        for (const photo of photos.photos) {
          cands.push({
            ref: `pexels-photo:${photo.id}`, source: "pexels-photo", query, scene: scene.id,
            title: photo.alt, author: photo.photographer, license: "Pexels License", pageUrl: photo.url,
            width: photo.width, height: photo.height, thumbs: [photo.src.medium],
          });
        }
        await emitCandidates(`pexels-${scene.id}-${qi}`, `${scene.id} «${scene.passage}» — Pexels: ${query}`, cands);
      }
    }
    return;
  }

  if (part === "commons") {
    for (const scene of spec.scenes) {
      for (const [qi, query] of scene.commons.entries()) {
        const params = new URLSearchParams({
          action: "query", format: "json", generator: "search", gsrsearch: `${query} filetype:bitmap`, gsrnamespace: "6", gsrlimit: "20",
          prop: "imageinfo", iiprop: "url|size|extmetadata|mime", iiurlwidth: "480",
        });
        const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, { headers: { "User-Agent": UA } });
        if (!res.ok) throw new Error(`Commons ${res.status}`);
        const body = (await res.json()) as { query?: { pages?: Record<string, { title: string; index?: number; imageinfo?: { thumburl?: string; width: number; height: number; descriptionurl: string; extmetadata?: Record<string, { value?: string }> }[] }> } };
        const pages = Object.values(body.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        const cands: Cand[] = [];
        for (const page of pages) {
          const info = page.imageinfo?.[0];
          const meta = info?.extmetadata ?? {};
          const license = stripHtml(meta.LicenseShortName?.value);
          // Solo dominio público / CC0: lo que se puede usar sin condiciones de atribución ni compartir-igual.
          if (!info?.thumburl || !/public domain|^pd|cc0/i.test(license)) continue;
          cands.push({
            ref: `commons:${page.title}`, source: "commons", query, scene: scene.id,
            title: stripHtml(meta.ImageDescription?.value).slice(0, 160) || page.title,
            author: stripHtml(meta.Artist?.value).slice(0, 80), license, pageUrl: info.descriptionurl,
            date: stripHtml(meta.DateTimeOriginal?.value).slice(0, 40), width: info.width, height: info.height,
            thumbs: [info.thumburl],
          });
        }
        await emitCandidates(`commons-${scene.id}-${qi}`, `${scene.id} «${scene.passage}» — Commons (PD): ${query}`, cands);
      }
    }
    return;
  }

  if (part === "detail") {
    // DETAIL_REFS: "pexels-video:123|pexels-photo:456|commons:File:X.jpg|existing:<path>" (separados por "|")
    const refs = (process.env.DETAIL_REFS ?? "").split("|").map((s) => s.trim()).filter(Boolean);
    const key = process.env.PEXELS_API_KEY;
    for (const [i, ref] of refs.entries()) {
      const tiles: { image: Buffer; label: string }[] = [];
      let meta: Record<string, unknown> = { ref };
      if (ref.startsWith("pexels-video:")) {
        const res = await fetch(`https://api.pexels.com/videos/videos/${ref.split(":")[1]}`, { headers: { Authorization: key ?? "" } });
        const video = (await res.json()) as { duration: number; url: string; user?: { name?: string }; video_files: { link: string; width: number | null; height: number | null; quality: string | null; file_type: string }[] };
        const file = video.video_files.filter((f) => f.file_type === "video/mp4" && (f.width ?? 0) >= 960 && (f.width ?? 0) <= 1920).sort((a, b) => (a.width ?? 0) - (b.width ?? 0))[0] ?? video.video_files[0];
        const local = path.join(tmp, `d${i}.mp4`);
        await fs.writeFile(local, await fetchBuffer(file.link));
        const duration = await probeDuration(local);
        for (const f of [0.02, 0.25, 0.5, 0.75, 0.97]) {
          const image = await frameAt(local, duration * f, 640).catch(() => null);
          if (image) tiles.push({ image, label: `${ref} @${(duration * f).toFixed(1)}s de ${duration.toFixed(1)}s` });
        }
        meta = { ref, durationSeconds: duration, pageUrl: video.url, author: video.user?.name, file: { width: file.width, height: file.height } };
      } else if (ref.startsWith("pexels-photo:")) {
        const res = await fetch(`https://api.pexels.com/v1/photos/${ref.split(":")[1]}`, { headers: { Authorization: key ?? "" } });
        const photo = (await res.json()) as { url: string; alt?: string; photographer: string; src: { large: string } };
        tiles.push({ image: await fetchBuffer(photo.src.large), label: `${ref} ${photo.alt ?? ""}` });
        meta = { ref, pageUrl: photo.url, author: photo.photographer, title: photo.alt };
      } else if (ref.startsWith("commons:")) {
        const params = new URLSearchParams({ action: "query", format: "json", titles: ref.slice("commons:".length), prop: "imageinfo", iiprop: "url|size|extmetadata", iiurlwidth: "1280" });
        const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, { headers: { "User-Agent": UA } });
        const body = (await res.json()) as { query: { pages: Record<string, { imageinfo?: { thumburl: string; descriptionurl: string; width: number; height: number; extmetadata?: Record<string, { value?: string }> }[] }> } };
        const info = Object.values(body.query.pages)[0]?.imageinfo?.[0];
        if (info) {
          tiles.push({ image: await fetchBuffer(info.thumburl), label: ref });
          const m = info.extmetadata ?? {};
          meta = {
            ref, pageUrl: info.descriptionurl, width: info.width, height: info.height,
            license: stripHtml(m.LicenseShortName?.value), author: stripHtml(m.Artist?.value), date: stripHtml(m.DateTimeOriginal?.value),
            description: stripHtml(m.ImageDescription?.value).slice(0, 600), credit: stripHtml(m.Credit?.value).slice(0, 200),
          };
        }
      } else if (ref.startsWith("existing:")) {
        const { createServiceClient } = await import("../src/lib/supabase/service");
        const { data } = await createServiceClient().storage.from("videos").download(ref.slice("existing:".length));
        if (data) {
          const buffer = Buffer.from(await data.arrayBuffer());
          if (ref.endsWith(".mp4")) {
            const local = path.join(tmp, `d${i}.mp4`);
            await fs.writeFile(local, buffer);
            const duration = await probeDuration(local);
            for (const f of [0.02, 0.25, 0.5, 0.75, 0.97]) {
              const image = await frameAt(local, duration * f, 640).catch(() => null);
              if (image) tiles.push({ image, label: `${ref.split("/").pop()} @${(duration * f).toFixed(1)}s de ${duration.toFixed(1)}s` });
            }
            meta = { ref, durationSeconds: duration };
          } else {
            tiles.push({ image: buffer, label: ref.split("/").pop() ?? ref });
          }
        }
      }
      console.log(`@@DETAIL ${JSON.stringify(meta)}`);
      if (tiles.length > 0) emitSheet(`detail-${i}`, await buildContactSheet(tiles, { columns: tiles.length > 1 ? 3 : 1, tileWidth: 640, tileHeight: 360, title: ref }));
    }
    return;
  }
  throw new Error(`PART desconocido: ${part}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
