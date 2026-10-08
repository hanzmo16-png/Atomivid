/**
 * Cinematic Opening V6 — prueba LOCAL con el renderer REAL (BEFORE_V4 · V5_SEQUENCE · V6_CINEMATIC).
 *
 * Las tres versiones pasan por generateLongFormVideoFromScript (produce.ts) con EXACTAMENTE los mismos
 * cuatro archivos FIXTURE_ONLY (SHA-256 verificado), la misma narración y la misma voz de fixture; se
 * renderiza lo que produce le entregaría al renderer. Sin red externa, sin proveedores, sin gasto.
 *
 *   REMOTION_BROWSER_EXECUTABLE=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell \
 *     npx tsx scripts/cinematic-opening-v6-proof.ts
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
import { containRect, revealLayout, wideFieldBox } from "../remotion/long-form-direction";
import { memoryShotAssetStore } from "../src/lib/video/long-form/durable-shot-assets";
import { planFor, produceOffline } from "../src/lib/video/long-form/cinematic-simulation";
import { sequenceDirectionFindings } from "../src/lib/video/long-form/sequence-direction";
import { hookStatus } from "../src/lib/video/long-form/impact-direction";
import { SHOWCASE_FILES, SHOWCASE_TOPIC, PORTRAIT_SUBJECT, showcaseBeats, showcaseFootageProvider, showcaseRegistry, showcaseSequences, showcaseSequencesV6 } from "../src/lib/video/long-form/showcase-fixtures";
import type { SequenceIntent } from "../src/lib/video/long-form/sequence-intent";

const OUT = path.join(process.cwd(), "docs/quality/cinematic-opening-v6");
const FPS = 30;
type Box = { x: number; y: number; w: number; h: number };
type Run = { label: string; scenes: LongFormShotScene[]; captions: LongFormDocProps["captions"]; durationSeconds: number; downloaded: string[]; renderedSources: string[]; planVersion: number };

async function main() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    throw new Error(`red prohibida: ${String(input)}`);
  }) as typeof fetch;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cinematic-v6-"));
  const fixtureDir = path.join(root, "fixture-only");
  fs.mkdirSync(fixtureDir, { recursive: true });
  const sha: Record<string, string> = {};
  for (const [file, spec] of Object.entries(SHOWCASE_FILES)) {
    const target = path.join(fixtureDir, file);
    if (file.endsWith(".svg")) fs.writeFileSync(target, spec.svg());
    else await sharp(Buffer.from(spec.svg())).png().toFile(target);
    sha[file] = createHash("sha256").update(fs.readFileSync(target)).digest("hex");
  }
  // Recreación IA REAL del repositorio, SOLO para comprobar el rótulo "Recreación IA" en 9:16 (fuera del A/B).
  fs.copyFileSync("content/long-form/gobekli-tepe-001/reference-images/bench-v2-a-pillar-transport.png", path.join(root, "ai-recreation.png"));
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "");
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return void res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": /\.svg(\+xml)?$/.test(file) ? "image/svg+xml" : "image/png", "Access-Control-Allow-Origin": "*" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const readLocal = async (url: string) => fs.readFileSync(path.join(root, new URL(url).pathname.replace(/^\/+/, "")));

  const run = async (label: string, sequences?: SequenceIntent[]): Promise<Run> => {
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
    const plan = planFor(showcaseBeats, "economical", sequences, SHOWCASE_TOPIC);
    const result = await produceOffline(showcaseBeats, plan, {
      topic: SHOWCASE_TOPIC,
      verifiedAssets: showcaseRegistry(base),
      footageProvider: showcaseFootageProvider(base, async (u) => (downloaded.add(new URL(u).pathname), readLocal(u))),
      store,
      curatedSvgMarkup: async (objectPath) => fs.readFileSync(path.join(objects, objectPath), "utf8"),
      onRender: (i) => (input = i as never),
    });
    if (result.error || !input) throw new Error(`${label}: ${String(result.error)}`);
    const captured = input as { scenes: LongFormShotScene[]; captions: LongFormDocProps["captions"]; durationSeconds: number };
    const renderedSources = new Set<string>();
    for (const s of captured.scenes) {
      if (s.asset.kind === "graphic" && s.asset.graphic.kind === "curated_svg") renderedSources.add("schematic.svg");
      if (s.asset.kind !== "media") continue;
      const h = createHash("sha256").update(fs.readFileSync(path.join(root, new URL(s.asset.url).pathname.replace(/^\/+/, "")))).digest("hex");
      renderedSources.add(Object.entries(sha).find(([, v]) => v === h)?.[0] ?? `DESCONOCIDO:${h.slice(0, 12)}`);
    }
    return { label, ...captured, downloaded: [...downloaded].sort(), renderedSources: [...renderedSources].sort(), planVersion: plan.version };
  };
  const v4 = await run("v4");
  const v5 = await run("v5", showcaseSequences);
  const v6 = await run("v6", showcaseSequencesV6);

  const serveUrl = await bundle({ entryPoint: path.join(process.cwd(), "remotion", "index.ts") });
  const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE || undefined;
  const chromeMode = "headless-shell" as const;
  const props = (r: Pick<Run, "durationSeconds" | "scenes" | "captions">, scenes = r.scenes, captions = r.captions): LongFormDocProps => ({ audioUrl: "", durationSeconds: r.durationSeconds, scenes, captions, narrationGaps: [], soundCues: [] });
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

  // 1) Los tres MP4 completos (silenciosos: sin TTS), mismo guion, mismos archivos, misma duración.
  for (const [file, r] of [["BEFORE_V4", v4], ["V5_SEQUENCE", v5], ["V6_CINEMATIC", v6]] as const) {
    const p = props(r);
    await renderMedia({ composition: await composition(p, H), serveUrl, codec: "h264", crf: 28, outputLocation: path.join(OUT, `${file}.mp4`), inputProps: p, browserExecutable, chromeMode, concurrency: 2, muted: true });
  }

  // 2) Comparación alineada en el tiempo (los primeros 10 s más densos: ahí se juzga la apertura).
  const times = [0.6, 2.5, 5.0, 7.5, 9.9, 12.0, 19.8, 24.0, 28.5, 31.5, 38.0, 42.6];
  const cells: string[] = [];
  const labels: string[] = [];
  for (const t of times) {
    for (const r of [v4, v5, v6]) {
      cells.push(await still(`cmp-${r.label}-${t}`, props(r), t));
      const sh = sceneAt(r.scenes, t)?.direction?.shot;
      labels.push(`${r.label.toUpperCase()} · t=${t.toFixed(1)} s${sh ? ` · ${sh.role} ${sh.scale}${sh.impact ? ` · impacto ${sh.impact}` : ""}` : ""}`);
    }
  }
  await sheet("COMPARISON_V4_V5_V6", cells, labels, 3, 620);

  // 3) V6: cuadros por plano (en el momento que define cada plano).
  const v6Frames: string[] = [];
  for (const [i, s] of v6.scenes.entries()) {
    const at = s.direction?.shot?.statement ? 2.5 : s.direction?.shot?.name ? s.startSeconds + 2.5 : s.startSeconds + (s.endSeconds - s.startSeconds) * (s.direction?.shot?.reveal ? 0.8 : 0.6);
    const f = await still(`v6-${i + 1}`, props(v6), at);
    v6Frames.push(f);
    await sharp(f).jpeg({ quality: 88 }).toFile(path.join(OUT, "frames", `V6-${i + 1}-${s.direction?.shot?.role}-${s.direction?.shot?.scale}-I${s.direction?.shot?.impact}.jpg`));
  }
  // La revelación del documento en cinco momentos (página → movimiento → titular dominante).
  const reveal = v6.scenes.find((s) => s.direction?.shot?.reveal)!;
  for (const p of [0.05, 0.25, 0.4, 0.55, 0.85]) {
    const f = await still(`v6-reveal-${p}`, props(v6), reveal.startSeconds + (reveal.endSeconds - reveal.startSeconds) * p);
    v6Frames.push(f);
  }
  await sheet(
    "V6_SHOTS",
    v6Frames,
    [
      ...v6.scenes.map((s, i) => `${i + 1} · ${s.direction?.shot?.role} · ${s.direction?.shot?.scale} · impacto ${s.direction?.shot?.impact} · ${s.direction?.transition?.type}`),
      ...[0.05, 0.25, 0.4, 0.55, 0.85].map((p) => `revelación ${Math.round(p * 100)} %`),
    ],
    3,
    900,
  );

  // 4) 9:16: la revelación del titular (crédito + subtítulos) y el rótulo "Recreación IA" con subtítulos.
  const vt = reveal.startSeconds + (reveal.endSeconds - reveal.startSeconds) * 0.8;
  const vertical = await still("vertical-headline", props(v6), vt, V);
  await sharp(vertical).jpeg({ quality: 90 }).toFile(path.join(OUT, "VERTICAL_9x16.jpg"));
  const aiScene: LongFormShotScene = { id: "ai", startSeconds: 0, endSeconds: 6, motion: "static", provenance: "ai_recreation", asset: { kind: "media", mediaType: "image", url: `${base}/ai-recreation.png` }, direction: { camera: "push", transition: { type: "cut" }, shot: { role: "ATMOSPHERE", scale: "MEDIUM", focus: { x: 0.5, y: 0.5 } } } };
  const aiCaptions = [{ text: "Workers moved the carved pillar across the hill", startSeconds: 0, endSeconds: 6 }];
  const aiProps = (scenes: LongFormShotScene[], captions: LongFormDocProps["captions"]): LongFormDocProps => ({ audioUrl: "", durationSeconds: 6, scenes, captions, narrationGaps: [], soundCues: [] });
  const aiFull = await still("ai-full", aiProps([aiScene], aiCaptions), 3, V);
  const aiNoLabel = await still("ai-nolabel", aiProps([{ ...aiScene, provenance: undefined }], aiCaptions), 3, V);
  const aiNoCap = await still("ai-nocap", aiProps([aiScene], []), 3, V);
  await sharp(aiFull).jpeg({ quality: 88 }).toFile(path.join(OUT, "VERTICAL_9x16_AI_LABEL_CHECK.jpg"));

  // 5) Colisiones del crédito MEDIDAS (cuadro − cuadro sin crédito), 16:9 y 9:16, contra el contenido, los subtítulos y el borde.
  const collisions: Record<string, unknown>[] = [];
  const noCredit = v6.scenes.map((s) => ({ ...s, creditText: undefined }));
  for (const [size, tag] of [[H, "16:9"], [V, "9:16"]] as const) {
    for (const [i, s] of v6.scenes.entries()) {
      if (!s.creditText) continue;
      const p = s.direction?.shot?.reveal ? 0.8 : 0.5;
      const t = s.startSeconds + (s.endSeconds - s.startSeconds) * p;
      const all = await still(`col-${tag}-${i}`, props(v6), t, size);
      const credit = await diffBox(await still(`col-${tag}-${i}-nc`, props(v6, noCredit), t, size), all);
      const caption = await diffBox(await still(`col-${tag}-${i}-ncap`, props(v6, v6.scenes, []), t, size), all);
      const content = contentBox(s, size.width, size.height, p);
      collisions.push({ aspect: tag, scene: `${i + 1} ${s.direction?.shot?.role}/${s.direction?.shot?.scale}`, credit, caption, content, touchesContent: touches(credit, content), touchesSubtitles: touches(credit, caption), touchesFrameEdge: edge(credit, size) });
    }
  }
  const aiLabel = await diffBox(aiNoLabel, aiFull);
  const aiCaption = await diffBox(aiNoCap, aiFull);
  const labelCheck = { label: aiLabel, caption: aiCaption, labelTouchesSubtitles: touches(aiLabel, aiCaption), labelEdge: edge(aiLabel, V), captionEdge: edge(aiCaption, V) };

  const report = {
    sameSourceFiles: { sha256: sha, v4: { downloaded: v4.downloaded, rendered: v4.renderedSources }, v5: { downloaded: v5.downloaded, rendered: v5.renderedSources }, v6: { downloaded: v6.downloaded, rendered: v6.renderedSources } },
    planVersions: { v4: v4.planVersion, v5: v5.planVersion, v6: v6.planVersion },
    duration: { v4: v4.durationSeconds, v5: v5.durationSeconds, v6: v6.durationSeconds },
    narrationWords: { v4: words(v4.captions).length, v5: words(v5.captions).length, v6: words(v6.captions).length, identical: words(v4.captions).join(" ") === words(v6.captions).join(" ") && words(v5.captions).join(" ") === words(v6.captions).join(" ") },
    hook: { v6: hookStatus(v6.scenes) },
    shots: Object.fromEntries([v4, v5, v6].map((r) => [r.label, r.scenes.map((s) => ({ id: s.id, start: +s.startSeconds.toFixed(2), end: +s.endSeconds.toFixed(2), kind: s.asset.kind, camera: s.direction?.camera, shot: s.direction?.shot ? { role: s.direction.shot.role, scale: s.direction.shot.scale, impact: s.direction.shot.impact, wide: s.direction.shot.wide, reveal: s.direction.shot.reveal, statement: s.direction.shot.statement, name: s.direction.shot.name } : undefined, document: !!s.direction?.document, transition: s.direction?.transition?.type }))])),
    findings: {
      v4: sequenceDirectionFindings(v4.scenes, v4.scenes.map(() => ({}))),
      v5: sequenceDirectionFindings(v5.scenes, v5.scenes.map((_, i) => ({ sequenceSlot: { sequenceId: i < 2 ? "S1" : "S2" } as never }))),
      v6: sequenceDirectionFindings(v6.scenes, v6.scenes.map((_, i) => ({ sequenceSlot: { sequenceId: i < 2 ? "S1" : "S2" } as never }))),
    },
    collisions,
    verticalAiLabel: labelCheck,
  };
  fs.writeFileSync(path.join(OUT, "measurements.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ same: report.sameSourceFiles, versions: report.planVersions, duration: report.duration, narration: report.narrationWords, hook: report.hook, findings: report.findings, collisions: collisions.map((c) => [c.aspect, c.scene, c.touchesContent, c.touchesSubtitles, c.touchesFrameEdge]), labelCheck }, null, 1));
  server.close();
}

const words = (c: LongFormDocProps["captions"]) => c.map((x) => x.text).join(" ").split(/\s+/);
const touches = (a: Box | null, b: Box | null) => !!a && !!b && !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
const edge = (b: Box | null, size: { width: number; height: number }) => !b || b.x < 16 || b.y < 16 || b.x + b.w > size.width - 16 || b.y + b.h > size.height - 16;

function sceneAt(scenes: LongFormShotScene[], t: number) {
  return scenes.find((s) => t >= s.startSeconds && t < s.endSeconds);
}

/** Contenido principal: la página/imagen visible del plano general, la página visible de la revelación, el sujeto curado del MEDIUM. */
function contentBox(s: LongFormShotScene, W: number, H: number, progress: number): Box | null {
  const shot = s.direction?.shot;
  if (!shot) return null;
  const box = wideFieldBox(W, H);
  if (shot.scale === "DETAIL" && shot.region && shot.sourceWidth && shot.sourceHeight) {
    const R = revealLayout(shot.region, shot.sourceWidth, shot.sourceHeight, W, H, progress);
    const top = Math.max(R.page.y, box.y);
    const bottom = Math.min(R.page.y + R.page.h, box.y + box.h);
    return { x: R.page.x, y: top, w: R.page.w, h: bottom - top };
  }
  if (s.asset.kind === "graphic") return box;
  if (shot.scale === "WIDE" && shot.wide !== "bleed") {
    const size = /S2-1$/.test(s.id) ? { w: 1800, h: 2400 } : { w: 2400, h: 1600 };
    const r = containRect(box, size.w, size.h);
    return { x: r.x, y: r.y, w: r.w, h: r.h };
  }
  if (shot.scale === "MEDIUM" && shot.focus) {
    const s0 = Math.max(W / 2400, H / 1600);
    const ox = (W - 2400 * s0) / 2;
    const oy = (H - 1600 * s0) / 2;
    const fx = shot.focus.x * W;
    const fy = shot.focus.y * H;
    const map = (px: number, py: number) => ({ x: fx + 1.08 * (ox + px * 2400 * s0 - fx), y: fy + 1.08 * (oy + py * 1600 * s0 - fy) });
    const a = map(PORTRAIT_SUBJECT.x, PORTRAIT_SUBJECT.y);
    const b = map(PORTRAIT_SUBJECT.x + PORTRAIT_SUBJECT.w, PORTRAIT_SUBJECT.y + PORTRAIT_SUBJECT.h);
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

async function sheet(name: string, files: string[], labels: string[], cols: number, tileW: number) {
  const meta = await sharp(files[0]).metadata();
  const tileH = Math.round((tileW * meta.height!) / meta.width!);
  const labelH = 36;
  const rows = Math.ceil(files.length / cols);
  const W = cols * tileW + (cols + 1) * 12;
  const Ht = rows * (tileH + labelH) + (rows + 1) * 12 + 50;
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const composites: OverlayOptions[] = [{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="50"><text x="12" y="34" font-family="Arial" font-size="22" font-weight="700" fill="#fff">${esc(name)} — renderer real (LongFormDoc) · FIXTURE_ONLY · mismos 4 archivos (SHA-256)</text></svg>`), top: 0, left: 0 }];
  for (let i = 0; i < files.length; i++) {
    const left = 12 + (i % cols) * (tileW + 12);
    const top = 50 + 12 + Math.floor(i / cols) * (tileH + labelH + 12);
    composites.push({ input: await sharp(files[i]).resize(tileW, tileH).toBuffer(), top, left });
    composites.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tileW}" height="${labelH}"><text x="4" y="24" font-family="Arial" font-size="17" fill="#ddd">${esc(labels[i] ?? "")}</text></svg>`), top: top + tileH, left });
  }
  await sharp({ create: { width: W, height: Ht, channels: 3, background: "#141418" } }).composite(composites).jpeg({ quality: 82 }).toFile(path.join(OUT, `${name}.jpg`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
