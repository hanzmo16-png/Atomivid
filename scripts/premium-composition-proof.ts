/**
 * Prueba visual LOCAL de Premium Composition V1 — el RENDERER REAL
 * (remotion/LongFormDoc.tsx vía @remotion/bundler + @remotion/renderer
 * renderStill), con escenas producidas por la MISMA ruta que producción:
 * curaduría → rehidratación → ejecutor → informe/Director → directAnchoredScenes.
 *
 * Sin proveedores, sin red externa (un servidor HTTP local sirve los fixtures),
 * sin gasto. Material 100 % propio marcado FIXTURE.
 *
 *   REMOTION_BROWSER_EXECUTABLE=/ruta/a/headless_shell npx tsx scripts/premium-composition-proof.ts
 *
 * Salida: docs/quality/premium-composition-v1/ (hojas de contacto + cuadros clave + medidas.json).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import type { LongFormDocProps, LongFormShotScene } from "../remotion/LongFormDoc";
import { documentFrame, easedProgress, safeAreas, svgRevealState } from "../remotion/long-form-direction";
import { DocumentAssetRegistry } from "../src/lib/video/long-form/asset-identity";
import { executeShot, type ShotExecution } from "../src/lib/video/long-form/shot-executor";
import { memoryShotAssetStore } from "../src/lib/video/long-form/durable-shot-assets";
import { ProductionBudget, memoryBudgetStore } from "../src/lib/video/long-form/production-budget";
import { emptyAiVideoLedgerState, getAiVideoCostConfig } from "../src/lib/video/long-form/ai-video-cost-guard";
import { getGenerativeUnitCosts, type AllocatedShot } from "../src/lib/video/long-form/production-plan";
import { directAnchoredScenes } from "../src/lib/video/long-form/produce";
import { buildVisualReport } from "../src/lib/video/long-form/visual-report";
import { curatedSvgGraphic } from "../src/lib/video/long-form/premium-composition";
import type { VerifiedAssetRegistry } from "../src/lib/video/long-form/verified-assets";
import type { BeatVisual } from "../src/lib/video/long-form/visual-intents";
import { identify, poolProvider } from "../src/lib/video/long-form/cinematic-simulation";
import {
  FIXTURE_DOCUMENT_VISUAL,
  FIXTURE_PERSON_VISUAL,
  FIXTURE_SCHEMATIC_VISUAL,
  documentSvg,
  portraitSvg,
  premiumAssets,
  premiumRegistry,
  schematicSvg,
} from "../src/lib/video/long-form/premium-fixtures";

const OUT = path.join(process.cwd(), "docs/quality/premium-composition-v1");
const FPS = 30;
const SCENE_SEC = 9;
const FRAMES = SCENE_SEC * FPS;

async function main() {
  // Cualquier intento de red externa falla (solo el servidor local de fixtures).
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!/^https?:\/\/127\.0\.0\.1[:/]/.test(url)) throw new Error(`red externa prohibida: ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;

  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), "premium-fixtures-"));
  await sharp(Buffer.from(documentSvg())).png().toFile(path.join(fixtures, "document.png"));
  await sharp(Buffer.from(portraitSvg())).png().toFile(path.join(fixtures, "portrait.png"));
  fs.writeFileSync(path.join(fixtures, "schematic.svg"), schematicSvg());
  // Recreación IA REAL del repositorio (imagen generada para el benchmark de Göbekli Tepe): se rotula como tal.
  fs.copyFileSync("content/long-form/gobekli-tepe-001/reference-images/bench-v2-a-pillar-transport.png", path.join(fixtures, "ai-recreation.png"));

  const server = http.createServer((req, res) => {
    const file = path.join(fixtures, path.basename(decodeURIComponent((req.url ?? "/").split("?")[0])));
    if (!fs.existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": file.endsWith(".svg") ? "image/svg+xml" : "image/png", "Access-Control-Allow-Origin": "*" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const A = premiumAssets(base);
  const registry = premiumRegistry([
    { asset: A.portrait, visual: FIXTURE_PERSON_VISUAL },
    { asset: A.document, visual: FIXTURE_DOCUMENT_VISUAL },
    { asset: A.schematic, visual: FIXTURE_SCHEMATIC_VISUAL },
  ]);

  // Escenas por la ruta productiva: ejecutor (con el registro) → informe/Director → directAnchoredScenes.
  const portraitScene = (await productionScenes([{ id: "portrait", visual: FIXTURE_PERSON_VISUAL }], registry))[0];
  const documentScene = (await productionScenes([{ id: "document", visual: FIXTURE_DOCUMENT_VISUAL }], registry))[0];
  const [schematicRecord] = registry.recordsFor(FIXTURE_SCHEMATIC_VISUAL);
  const svgGraphic = curatedSvgGraphic(schematicRecord, schematicSvg(), { isFixture: true });
  if (!svgGraphic) throw new Error("el SVG curado no pasó la puerta de confianza");
  const svgScene = (look?: "schematic_mono"): LongFormShotScene => ({
    id: "schematic",
    startSeconds: 0,
    endSeconds: SCENE_SEC,
    motion: "static",
    asset: { kind: "graphic", graphic: svgGraphic },
    provenance: "archival_documentary",
    creditText: schematicRecord.creditText,
    direction: { camera: "still", transition: { type: "cut" }, ...(look ? { look: { preset: look } } : {}) },
  });
  const aiScene: LongFormShotScene = { id: "ai", startSeconds: 0, endSeconds: SCENE_SEC, motion: "ken_burns", asset: { kind: "media", mediaType: "image", url: `${base}/ai-recreation.png` }, provenance: "ai_recreation", direction: { camera: "push", transition: { type: "cut" } } };
  const caption = [{ text: "The fixture gazette reported the event on its front page", startSeconds: 0, endSeconds: SCENE_SEC }];
  const aiCaption = [{ text: "Workers moved the carved pillar across the hill", startSeconds: 0, endSeconds: SCENE_SEC }];

  const serveUrl = await bundle({ entryPoint: path.join(process.cwd(), "remotion", "index.ts") });
  const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE || undefined;
  const chromeMode = (process.env.REMOTION_CHROME_MODE as "headless-shell" | "chrome-for-testing" | undefined) || "headless-shell";
  const still = async (name: string, scenes: LongFormShotScene[], frame: number, size: { width: number; height: number }, captions: LongFormDocProps["captions"] = []) => {
    const inputProps: LongFormDocProps = { audioUrl: "", durationSeconds: SCENE_SEC, scenes, captions, narrationGaps: [], soundCues: [] };
    const composition = await selectComposition({ serveUrl, id: "LongFormDoc", inputProps, browserExecutable, chromeMode });
    const output = path.join(fixtures, "frames", `${name}.png`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    await renderStill({ composition: { ...composition, ...size, durationInFrames: FRAMES }, serveUrl, output, inputProps, frame, imageFormat: "png", browserExecutable, chromeMode });
    return output;
  };
  const H = { width: 1920, height: 1080 };
  const V = { width: 1080, height: 1920 };
  const at = (p: number) => Math.round(p * (FRAMES - 1));
  const facts: Record<string, unknown> = {};

  // A — retrato verificado, cámara con aceleración (el MISMO recurso; la persona sigue siendo una foto).
  const aP = [0, 0.25, 0.5, 0.75, 1];
  const aFrames = [];
  for (const p of aP) aFrames.push(await still(`A-portrait-p${p}`, [portraitScene], at(p), H));
  const camScale = (p: number) => 1 + 0.08 * easedProgress(p);
  facts.A = { direction: portraitScene.direction, samples: aP.map((p) => ({ progress: p, eased: +easedProgress(p).toFixed(4), scale: +camScale(p).toFixed(4), linearScale: +(1 + 0.08 * p).toFixed(4) })) };
  await sheet("A-portrait-eased-camera", aFrames, aP.map((p) => `p=${p} · escala ${camScale(p).toFixed(3)} (lineal ${(1 + 0.08 * p).toFixed(3)})`), 3);

  // B — documento verificado: página → titular → fecha → salida.
  const bP = [0, 0.2, 0.45, 0.62, 0.76, 0.9, 1];
  const bFrames = [];
  for (const p of bP) bFrames.push(await still(`B-document-p${p}`, [documentScene], at(p), H));
  const doc = documentScene.direction!.document!;
  facts.B = { regions: doc.regions, samples: bP.map((p) => { const f = documentFrame(doc, p, 1920, 1080); return { progress: p, phase: f.phase, scale: +f.scale.toFixed(3), dim: +f.dim.toFixed(2) }; }) };
  await sheet("B-document-regions", bFrames, bP.map((p) => { const f = documentFrame(doc, p, 1920, 1080); return `p=${p} · ${f.phase} · zoom ${f.scale.toFixed(2)}`; }), 4);

  // C — look 1990s (color) vs referencia neutra, mismo recurso y mismo cuadro.
  const neutral = { ...portraitScene, direction: { ...portraitScene.direction!, look: undefined } };
  const cFrames = [await still("C-neutral-reference", [neutral], 0, H), await still("C-1990s", [portraitScene], 0, H)];
  facts.C = { look: portraitScene.direction?.look };
  await sheet("C-1990s-look", cFrames, ["referencia neutra (sin look)", `documentary_1990s · ${JSON.stringify(portraitScene.direction?.look)}`], 2);

  // D — esquema curado en monocromo explícito (y su versión en color).
  const dFrames = [await still("D-schematic-color", [svgScene()], FRAMES - 1, H), await still("D-schematic-mono", [svgScene("schematic_mono")], FRAMES - 1, H)];
  await sheet("D-schematic-mono", dFrames, ["SVG curado · color", "SVG curado · schematic_mono (saturación 0 solo en este preset)"], 2);

  // E — revelado del SVG curado: inicio / medio / fin.
  const eP = [0, 0.375, 0.7, 1];
  const eFrames = [];
  for (const p of eP) eFrames.push(await still(`E-svg-p${p}`, [svgScene()], at(p), H));
  facts.E = eP.map((p) => ({ progress: p, ...svgRevealState(p) }));
  await sheet("E-svg-reveal", eFrames, eP.map((p) => { const s = svgRevealState(p); return `p=${p} · trazo ${(s.pathDrawn * 100).toFixed(0)} % · etiqueta ${(s.labelOpacity * 100).toFixed(0)} %`; }), 2);

  // F — 9:16: recurso verificado + crédito + subtítulos; G — 9:16: rótulo "Recreación IA" + subtítulos.
  const strip = (s: LongFormShotScene): LongFormShotScene => ({ ...s, creditText: undefined, provenance: s.provenance === "ai_recreation" ? undefined : s.provenance });
  const fMid = at(0.5);
  const f = { full: await still("F-vertical-portrait", [portraitScene], fMid, V, caption), base: await still("F-vertical-base", [strip(portraitScene)], fMid, V), credit: await still("F-vertical-credit", [portraitScene], fMid, V), caption: await still("F-vertical-caption", [strip(portraitScene)], fMid, V, caption) };
  const g = { full: await still("G-vertical-ai", [aiScene], fMid, V, aiCaption), base: await still("G-vertical-base", [strip(aiScene)], fMid, V), label: await still("G-vertical-label", [aiScene], fMid, V), caption: await still("G-vertical-caption", [strip(aiScene)], fMid, V, aiCaption) };
  const docV = await still("F-vertical-document-headline", [documentScene], at(0.45), V, caption);
  const safe = safeAreas(V.width, V.height);
  const credit = await bbox(f.base, f.credit);
  const fCaption = await bbox(f.base, f.caption);
  const label = await bbox(g.base, g.label);
  const gCaption = await bbox(g.base, g.caption);
  facts.vertical = { safe, F: { credit, caption: fCaption, checks: layoutChecks(credit, fCaption, V) }, G: { label, caption: gCaption, checks: layoutChecks(label, gCaption, V) } };
  await sheet("F-vertical-asset-credit-captions", [f.full, docV], ["9:16 · retrato verificado + crédito + subtítulos", "9:16 · documento verificado (titular) + crédito + subtítulos"], 2);
  await sheet("G-vertical-ai-label", [g.full], ["9:16 · Recreación IA + subtítulos"], 1);

  fs.mkdirSync(path.join(OUT, "frames"), { recursive: true });
  for (const [src, dst] of [[aFrames[2], "A-portrait-mid.jpg"], [bFrames[2], "B-document-headline.jpg"], [bFrames[4], "B-document-date.jpg"], [cFrames[1], "C-1990s.jpg"], [dFrames[1], "D-schematic-mono.jpg"], [eFrames[1], "E-svg-mid.jpg"], [f.full, "F-vertical-portrait.jpg"], [docV, "F-vertical-document.jpg"], [g.full, "G-vertical-ai.jpg"]] as const) {
    await sharp(src).jpeg({ quality: 88 }).toFile(path.join(OUT, "frames", dst));
  }
  fs.writeFileSync(path.join(OUT, "measurements.json"), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify(facts.vertical, null, 2));
  server.close();
}

async function productionScenes(items: { id: string; visual: BeatVisual }[], registry: VerifiedAssetRegistry): Promise<LongFormShotScene[]> {
  const shots = items.map((it, i) => ({ id: it.id, beatId: "b", startSec: i * SCENE_SEC, endSec: (i + 1) * SCENE_SEC, durationSec: SCENE_SEC, type: "ken_burns_image", source: "stock", assetId: it.id, visualIntent: it.visual.description, motion: "ken_burns", captionText: "", narrationFragment: "", anchoredVisual: it.visual, license: "resolved-at-execution", attribution: "", dedupKey: it.id, status: "planned", validationStatus: "pending", plannedType: "ken_burns_image" }) as AllocatedShot);
  const deps = {
    topic: "premium composition proof",
    footageProvider: poolProvider([]).provider,
    imageProvider: { name: "fixture", capabilities: { id: "f", models: ["m"], formats: ["image/png"], aspectRatios: ["16:9"], timeoutMs: 1, maxRetries: 0 }, isAvailable: () => true, generateImage: async () => { throw new Error("sin IA"); } },
    store: memoryShotAssetStore().store,
    budget: await ProductionBudget.open(memoryBudgetStore(), { maxAiImageGenerations: 0, maxAiVideoClips: 0, maxGenerativeUsd: 0 }),
    units: getGenerativeUnitCosts(),
    aiVideoCostConfig: getAiVideoCostConfig("balanced"),
    totalDurationSec: SCENE_SEC * items.length,
    requireReal: false,
    visualPipeline: "anchored_v1" as const,
    registry: new DocumentAssetRegistry(),
    identify,
    verifiedAssets: registry,
  };
  const executions: ShotExecution[] = [];
  for (const shot of shots) executions.push(await executeShot(shot, deps as never, emptyAiVideoLedgerState()));
  const report = buildVisualReport({ requestId: "proof", planVersion: 4, topic: "proof", shots, executions, now: () => 0 });
  const scenes = directAnchoredScenes(
    shots.map((s, i) => {
      const record = registry.recordsFor(items[i].visual)[0];
      if (executions[i].asset.kind !== "media" || !record) throw new Error(`${s.id}: el recurso verificado no se ejecutó`);
      // El master real sirve el objeto persistido; aquí, el MISMO recurso desde el servidor local.
      return { id: s.id, startSeconds: s.startSec, endSeconds: s.endSec, asset: { kind: "media" as const, mediaType: "image" as const, url: record.mediaUrl }, motion: "ken_burns" as const };
    }),
    executions,
    [],
    report.cinematic!.scenes,
  );
  return scenes.map((s) => ({ ...s, startSeconds: 0, endSeconds: SCENE_SEC }));
}

/** Caja (px) de lo que añade una capa: diferencia entre el cuadro con la capa y sin ella. */
async function bbox(basePng: string, layerPng: string) {
  const [a, b] = await Promise.all([sharp(basePng).raw().toBuffer({ resolveWithObject: true }), sharp(layerPng).raw().toBuffer({ resolveWithObject: true })]);
  const { width, height, channels } = a.info;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 30) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

type Box = { x: number; y: number; w: number; h: number } | null;
function layoutChecks(top: Box, caption: Box, frame: { width: number; height: number }) {
  const inside = (b: Box) => !!b && b.x >= 16 && b.y >= 16 && b.x + b.w <= frame.width - 16 && b.y + b.h <= frame.height - 16;
  const overlap = !!top && !!caption && !(top.x + top.w <= caption.x || caption.x + caption.w <= top.x || top.y + top.h <= caption.y || caption.y + caption.h <= top.y);
  return {
    labelVisible: !!top,
    captionVisible: !!caption,
    labelInsideFrame: inside(top),
    captionInsideFrame: inside(caption),
    noOverlap: !overlap,
    labelClearsTopChrome: !!top && top.y >= Math.round(frame.height * 0.06),
    captionClearsBottomChrome: !!caption && caption.y + caption.h <= frame.height - Math.round(frame.height * 0.15),
  };
}

async function sheet(name: string, files: string[], labels: string[], cols: number) {
  const metas = await Promise.all(files.map((f) => sharp(f).metadata()));
  const tileW = metas[0].width! > metas[0].height! ? 960 : 540;
  const tileH = Math.round((tileW * metas[0].height!) / metas[0].width!);
  const labelH = 44;
  const rows = Math.ceil(files.length / cols);
  const W = cols * tileW + (cols + 1) * 16;
  const Ht = rows * (tileH + labelH) + (rows + 1) * 16 + 56;
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const composites: OverlayOptions[] = [{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="56"><text x="16" y="38" font-family="Arial" font-size="26" font-weight="700" fill="#fff">${esc(name)} — renderer real (LongFormDoc), fixtures propios</text></svg>`), top: 0, left: 0 }];
  for (let i = 0; i < files.length; i++) {
    const left = 16 + (i % cols) * (tileW + 16);
    const top = 56 + 16 + Math.floor(i / cols) * (tileH + labelH + 16);
    composites.push({ input: await sharp(files[i]).resize(tileW, tileH).toBuffer(), top, left });
    composites.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tileW}" height="${labelH}"><text x="4" y="30" font-family="Arial" font-size="${tileW > 600 ? 22 : 18}" fill="#ddd">${esc(labels[i] ?? "")}</text></svg>`), top: top + tileH, left });
  }
  fs.mkdirSync(OUT, { recursive: true });
  await sharp({ create: { width: W, height: Ht, channels: 3, background: "#16161a" } }).composite(composites).jpeg({ quality: 86 }).toFile(path.join(OUT, `${name}.jpg`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
