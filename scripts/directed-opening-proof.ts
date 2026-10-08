/**
 * Directed Opening V1 — prueba A/B LOCAL con el renderer REAL.
 *
 * BEFORE = plan v4 (producción actual) · AFTER = plan v5 (secuencias). Los dos pasan
 * por generateLongFormVideoFromScript (produce.ts) con EXACTAMENTE los mismos cuatro
 * archivos FIXTURE_ONLY (mismos bytes), el mismo guion y la misma voz de fixture; el
 * render recibe lo que produce le entregaría al renderer. Sin red externa, sin
 * proveedores, sin gasto.
 *
 *   REMOTION_BROWSER_EXECUTABLE=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell \
 *     npx tsx scripts/directed-opening-proof.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp, { type OverlayOptions } from "sharp";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import type { LongFormDocProps, LongFormShotScene } from "../remotion/LongFormDoc";
import { containRect, detailLayout, wideFieldBox } from "../remotion/long-form-direction";
import { memoryShotAssetStore } from "../src/lib/video/long-form/durable-shot-assets";
import { planFor, produceOffline } from "../src/lib/video/long-form/cinematic-simulation";
import { sequenceDirectionFindings } from "../src/lib/video/long-form/sequence-direction";
import { SHOWCASE_FILES, SHOWCASE_TOPIC, showcaseBeats, showcaseFootageProvider, showcaseRegistry, showcaseSequences } from "../src/lib/video/long-form/showcase-fixtures";
import type { SequenceIntent } from "../src/lib/video/long-form/sequence-intent";

const OUT = path.join(process.cwd(), "docs/quality/directed-opening-v1");
const FPS = 30;
type Box = { x: number; y: number; w: number; h: number };

async function main() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    throw new Error(`red prohibida: ${String(input)}`);
  }) as typeof fetch;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "directed-opening-"));
  const fixtureDir = path.join(root, "fixture-only");
  fs.mkdirSync(fixtureDir, { recursive: true });
  const sha: Record<string, string> = {};
  for (const [file, spec] of Object.entries(SHOWCASE_FILES)) {
    const target = path.join(fixtureDir, file);
    if (file.endsWith(".svg")) fs.writeFileSync(target, spec.svg());
    else await sharp(Buffer.from(spec.svg())).png().toFile(target);
    sha[file] = createHash("sha256").update(fs.readFileSync(target)).digest("hex");
  }
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "");
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": file.endsWith(".svg") || file.endsWith(".svg+xml") ? "image/svg+xml" : "image/png", "Access-Control-Allow-Origin": "*" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const readLocal = async (url: string) => fs.readFileSync(path.join(root, new URL(url).pathname.replace(/^\/+/, "")));

  // Una ejecución de produce() por versión, con su propio almacén (objetos servidos por el servidor local).
  const run = async (label: string, sequences?: SequenceIntent[]) => {
    const mem = memoryShotAssetStore();
    const objects = path.join(root, `objects-${label}`);
    const store = {
      ...mem.store,
      async putObject(objectPath: string, buffer: Buffer) {
        const f = path.join(objects, objectPath);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, buffer);
      },
      async signedUrl(objectPath: string) {
        return `${base}/objects-${label}/${objectPath}`;
      },
    };
    const downloaded = new Set<string>();
    let input: { scenes: LongFormShotScene[]; captions: LongFormDocProps["captions"]; durationSeconds: number } | null = null;
    const result = await produceOffline(showcaseBeats, planFor(showcaseBeats, "economical", sequences, SHOWCASE_TOPIC), {
      topic: SHOWCASE_TOPIC,
      verifiedAssets: showcaseRegistry(base),
      footageProvider: showcaseFootageProvider(base, async (u) => (downloaded.add(new URL(u).pathname), readLocal(u))),
      store,
      curatedSvgMarkup: async (objectPath) => fs.readFileSync(path.join(objects, objectPath), "utf8"),
      onRender: (i) => (input = i as never),
    });
    if (result.error || !input) throw new Error(`${label}: ${String(result.error)}`);
    const captured = input as { scenes: LongFormShotScene[]; captions: LongFormDocProps["captions"]; durationSeconds: number };
    // Bytes de cada objeto renderizado → archivo de origen (prueba de "mismos bytes").
    const renderedSources = new Set<string>();
    for (const s of captured.scenes) {
      if (s.asset.kind !== "media") continue;
      const bytes = fs.readFileSync(path.join(root, new URL(s.asset.url).pathname.replace(/^\/+/, "")));
      const h = createHash("sha256").update(bytes).digest("hex");
      renderedSources.add(Object.entries(sha).find(([, v]) => v === h)?.[0] ?? `DESCONOCIDO:${h.slice(0, 12)}`);
    }
    for (const s of captured.scenes) if (s.asset.kind === "graphic" && s.asset.graphic.kind === "curated_svg") renderedSources.add("schematic.svg");
    return { ...captured, downloaded: [...downloaded].sort(), renderedSources: [...renderedSources].sort() };
  };
  const before = await run("before");
  const after = await run("after", showcaseSequences);

  const serveUrl = await bundle({ entryPoint: path.join(process.cwd(), "remotion", "index.ts") });
  const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE || undefined;
  const chromeMode = "headless-shell" as const;
  const props = (r: typeof before, scenes = r.scenes, captions = r.captions): LongFormDocProps => ({ audioUrl: "", durationSeconds: r.durationSeconds, scenes, captions, narrationGaps: [], soundCues: [] });
  const composition = async (p: LongFormDocProps, size: { width: number; height: number }) => {
    const c = await selectComposition({ serveUrl, id: "LongFormDoc", inputProps: p, browserExecutable, chromeMode });
    return { ...c, ...size, durationInFrames: Math.round(p.durationSeconds * FPS) };
  };
  const H = { width: 1920, height: 1080 };
  const V = { width: 1080, height: 1920 };
  fs.mkdirSync(path.join(OUT, "frames"), { recursive: true });
  const still = async (name: string, p: LongFormDocProps, t: number, size = H) => {
    const output = path.join(root, "stills", `${name}.png`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    await renderStill({ composition: await composition(p, size), serveUrl, output, inputProps: p, frame: Math.min(Math.round(t * FPS), Math.round(p.durationSeconds * FPS) - 1), imageFormat: "png", browserExecutable, chromeMode });
    return output;
  };

  // 1) Los dos MP4 completos (silenciosos: sin TTS), mismo guion, mismos archivos.
  for (const [label, r] of [["before", before], ["after", after]] as const) {
    const p = props(r);
    await renderMedia({ composition: await composition(p, H), serveUrl, codec: "h264", crf: 28, outputLocation: path.join(OUT, `${label}.mp4`), inputProps: p, browserExecutable, chromeMode, concurrency: 2, muted: true });
  }

  // 2) Comparación alineada en el tiempo: BEFORE | AFTER cada ~4.3 s.
  const times = Array.from({ length: 10 }, (_, i) => 1.2 + i * ((Math.min(before.durationSeconds, after.durationSeconds) - 2.4) / 9));
  const pairs: string[] = [];
  const labels: string[] = [];
  for (const t of times) {
    pairs.push(await still(`cmp-before-${t.toFixed(1)}`, props(before), t), await still(`cmp-after-${t.toFixed(1)}`, props(after), t));
    labels.push(`BEFORE (v4) · t=${t.toFixed(1)} s`, `AFTER (v5) · t=${t.toFixed(1)} s · ${sceneAt(after.scenes, t)?.direction?.shot?.role ?? ""} ${sceneAt(after.scenes, t)?.direction?.shot?.scale ?? ""}`);
  }
  await sheet("COMPARISON-before-after", pairs, labels, 2);

  // 3) AFTER: un cuadro representativo por plano (mitad del plano) a resolución completa.
  const afterFrames: string[] = [];
  for (const [i, s] of after.scenes.entries()) {
    const t = s.startSeconds + (s.endSeconds - s.startSeconds) * (s.direction?.shot?.scale === "DETAIL" ? 0.7 : 0.5);
    const f = await still(`after-${i + 1}`, props(after), t);
    afterFrames.push(f);
    await sharp(f).jpeg({ quality: 88 }).toFile(path.join(OUT, "frames", `AFTER-${i + 1}-${s.direction?.shot?.role}-${s.direction?.shot?.scale}.jpg`));
  }
  await sheet("AFTER-shots", afterFrames, after.scenes.map((s, i) => `${i + 1} · ${s.direction?.shot?.role} · ${s.direction?.shot?.scale} · ${s.direction?.transition?.type}`), 3);
  const beforeFrames: string[] = [];
  for (const [i, s] of before.scenes.entries()) beforeFrames.push(await still(`before-${i + 1}`, props(before), s.startSeconds + (s.endSeconds - s.startSeconds) * 0.5));
  await sheet("BEFORE-shots", beforeFrames, before.scenes.map((s, i) => `${i + 1} · ${s.asset.kind === "graphic" ? "tarjeta" : s.direction?.document ? "documento V1" : s.direction?.camera ?? s.motion}${s.direction?.look?.scale ? ` · reencuadre ${s.direction.look.scale}` : ""}`), 4);

  // 4) Colisiones del crédito, MEDIDAS en píxeles (cuadro con crédito − sin crédito), 16:9 y 9:16.
  const collisions: Record<string, unknown>[] = [];
  const noCredit = after.scenes.map((s) => ({ ...s, creditText: undefined }));
  for (const [size, tag] of [[H, "16:9"], [V, "9:16"]] as const) {
    for (const [i, s] of after.scenes.entries()) {
      if (!s.creditText) continue;
      const t = s.startSeconds + (s.endSeconds - s.startSeconds) * (s.direction?.shot?.scale === "DETAIL" ? 0.7 : 0.5);
      const withAll = await still(`col-${tag}-${i}-all`, props(after), t, size);
      const without = await still(`col-${tag}-${i}-nocredit`, props(after, noCredit), t, size);
      const noCaptions = await still(`col-${tag}-${i}-nocap`, props(after, after.scenes, []), t, size);
      const credit = await diffBox(without, withAll);
      const caption = await diffBox(noCaptions, withAll);
      const content = contentBox(s, size.width, size.height, (t - s.startSeconds) / (s.endSeconds - s.startSeconds));
      const touches = (a: Box | null, b: Box | null) => !!a && !!b && !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
      collisions.push({
        aspect: tag,
        scene: `${i + 1} ${s.direction?.shot?.role}/${s.direction?.shot?.scale}`,
        credit,
        caption,
        content,
        touchesContent: touches(credit, content),
        touchesSubtitles: touches(credit, caption),
        touchesFrameEdge: !credit || credit.x < 16 || credit.y < 16 || credit.x + credit.w > size.width - 16 || credit.y + credit.h > size.height - 16,
      });
      if (tag === "9:16" && s.direction?.shot?.scale === "DETAIL") await sharp(withAll).jpeg({ quality: 90 }).toFile(path.join(OUT, "VERTICAL-9x16-headline.jpg"));
    }
  }

  const findings = {
    before: sequenceDirectionFindings(before.scenes, before.scenes.map(() => ({}))),
    after: sequenceDirectionFindings(after.scenes, after.scenes.map((s, i) => ({ sequenceSlot: { sequenceId: i < 2 ? "S1" : "S2" } as never }))),
  };
  const report = {
    sameSourceFiles: { sha256: sha, beforeDownloaded: before.downloaded, afterDownloaded: after.downloaded, beforeRendered: before.renderedSources, afterRendered: after.renderedSources },
    duration: { before: before.durationSeconds, after: after.durationSeconds },
    shots: {
      before: before.scenes.map((s) => ({ id: s.id, start: +s.startSeconds.toFixed(2), end: +s.endSeconds.toFixed(2), kind: s.asset.kind, camera: s.direction?.camera, document: !!s.direction?.document, look: s.direction?.look, transition: s.direction?.transition?.type })),
      after: after.scenes.map((s) => ({ id: s.id, start: +s.startSeconds.toFixed(2), end: +s.endSeconds.toFixed(2), role: s.direction?.shot?.role, scale: s.direction?.shot?.scale, transition: s.direction?.transition?.type, region: s.direction?.shot?.region?.label })),
    },
    findings,
    collisions,
  };
  fs.writeFileSync(path.join(OUT, "measurements.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ same: report.sameSourceFiles, findings, collisions: collisions.map((c) => ({ a: c.aspect, s: c.scene, content: c.touchesContent, subs: c.touchesSubtitles, edge: c.touchesFrameEdge })) }, null, 1));
  server.close();
}

function sceneAt(scenes: LongFormShotScene[], t: number) {
  return scenes.find((s) => t >= s.startSeconds && t < s.endSeconds);
}

/** Contenido principal de la imagen en el cuadro: la imagen del plano general, el titular del DETAIL, el sujeto curado del MEDIUM. */
function contentBox(s: LongFormShotScene, W: number, H: number, progress: number): Box | null {
  const shot = s.direction?.shot;
  if (!shot) return null;
  if (shot.scale === "DETAIL" && shot.region && shot.sourceWidth && shot.sourceHeight) {
    // Contenido = TODA la página visible (no solo el titular): el crédito no puede tocar el documento.
    const L = detailLayout(shot.region, shot.sourceWidth, shot.sourceHeight, W, H, progress);
    const box = wideFieldBox(W, H);
    const top = Math.max(L.page.y, box.y);
    const bottom = Math.min(L.page.y + L.page.h, box.y + box.h);
    return { x: L.page.x, y: top, w: L.page.w, h: bottom - top };
  }
  if (s.asset.kind === "graphic") return wideFieldBox(W, H);
  if (shot.scale === "WIDE") {
    const size = s.asset.url.includes("document") || /S2-1/.test(s.id) ? { w: 1800, h: 2400 } : { w: 2400, h: 1600 };
    const r = containRect(wideFieldBox(W, H), size.w, size.h);
    return { x: r.x, y: r.y, w: r.w, h: r.h };
  }
  if (shot.scale === "MEDIUM" && shot.focus) {
    // Retrato 2400×1600 a sangre ("cover") con el empuje ≤ 1.08 desde el sujeto: caja del sujeto curado (PORTRAIT_SUBJECT).
    const subject = { x: 0.395, y: 0.26, w: 0.21, h: 0.38 };
    const s0 = Math.max(W / 2400, H / 1600);
    const ox = (W - 2400 * s0) / 2;
    const oy = (H - 1600 * s0) / 2;
    const k = 1.08;
    const fx = shot.focus.x * W;
    const fy = shot.focus.y * H;
    const map = (px: number, py: number) => ({ x: fx + k * (ox + px * 2400 * s0 - fx), y: fy + k * (oy + py * 1600 * s0 - fy) });
    const a = map(subject.x, subject.y);
    const b = map(subject.x + subject.w, subject.y + subject.h);
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  }
  return null;
}

async function diffBox(a: string, b: string): Promise<Box | null> {
  const [x, y] = await Promise.all([sharp(a).raw().toBuffer({ resolveWithObject: true }), sharp(b).raw().toBuffer({ resolveWithObject: true })]);
  const { width, height, channels } = x.info;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const k = (j * width + i) * channels;
      if (Math.abs(x.data[k] - y.data[k]) + Math.abs(x.data[k + 1] - y.data[k + 1]) + Math.abs(x.data[k + 2] - y.data[k + 2]) > 30) {
        if (i < x0) x0 = i;
        if (j < y0) y0 = j;
        if (i > x1) x1 = i;
        if (j > y1) y1 = j;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

async function sheet(name: string, files: string[], labels: string[], cols: number) {
  const meta = await sharp(files[0]).metadata();
  const tileW = meta.width! > meta.height! ? 900 : 420;
  const tileH = Math.round((tileW * meta.height!) / meta.width!);
  const labelH = 40;
  const rows = Math.ceil(files.length / cols);
  const W = cols * tileW + (cols + 1) * 14;
  const Ht = rows * (tileH + labelH) + (rows + 1) * 14 + 52;
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const composites: OverlayOptions[] = [{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="52"><text x="14" y="36" font-family="Arial" font-size="24" font-weight="700" fill="#fff">${esc(name)} — renderer real (LongFormDoc) · FIXTURE_ONLY · mismos 4 archivos</text></svg>`), top: 0, left: 0 }];
  for (let i = 0; i < files.length; i++) {
    const left = 14 + (i % cols) * (tileW + 14);
    const top = 52 + 14 + Math.floor(i / cols) * (tileH + labelH + 14);
    composites.push({ input: await sharp(files[i]).resize(tileW, tileH).toBuffer(), top, left });
    composites.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tileW}" height="${labelH}"><text x="4" y="27" font-family="Arial" font-size="20" fill="#ddd">${esc(labels[i] ?? "")}</text></svg>`), top: top + tileH, left });
  }
  await sharp({ create: { width: W, height: Ht, channels: 3, background: "#141418" } }).composite(composites).jpeg({ quality: 84 }).toFile(path.join(OUT, `${name}.jpg`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
