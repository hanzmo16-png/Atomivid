#!/usr/bin/env node
/**
 * Renderiza un ambiente cinematográfico propio (USD 0): abre la escena HTML en Chromium, dibuja cada fotograma con
 * draw(t) determinista, lo captura como PNG y lo codifica con ffmpeg (H.264 + WebM VP9) más un póster JPEG.
 *
 *   node scripts/cinematic/render-ambient.cjs cosmos <outDir>
 *
 * Salida: <id>-<orient>.mp4 / .webm / -poster.jpg para landscape (1280×720) y portrait (720×1280).
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const id = process.argv[2] || "cosmos";
const out = path.resolve(process.argv[3] || "public/cinematic");
const FFMPEG = process.env.FFMPEG || require("@ffmpeg-installer/ffmpeg").path;
const FPS = 24, LOOP = 8;
const SIZES = { landscape: [1280, 720], portrait: [720, 1280] };

function ff(args) {
  return new Promise((res, rej) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["pipe", "inherit", "inherit"] });
    p.on("exit", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg ${c}`))));
    res.stdin = p.stdin; ff.last = p;
  });
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  for (const [orient, [w, h]] of Object.entries(SIZES)) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await page.goto("file://" + path.join(__dirname, `${id}-scene.html`));
    await page.evaluate(([w, h]) => window.setup(w, h), [w, h]);
    const frames = path.join(out, `.frames-${id}-${orient}`);
    fs.mkdirSync(frames, { recursive: true });
    const n = FPS * LOOP;
    for (let i = 0; i < n; i++) {
      const b64 = await page.evaluate((t) => { window.draw(t); return document.getElementById("c").toDataURL("image/png").slice(22); }, i / FPS);
      fs.writeFileSync(path.join(frames, `f${String(i).padStart(4, "0")}.png`), Buffer.from(b64, "base64"));
    }
    await page.close();
    const input = ["-framerate", String(FPS), "-i", path.join(frames, "f%04d.png")];
    const base = path.join(out, `${id}-${orient}`);
    // H.264: compatible con todo; faststart para empezar a reproducir antes de terminar la descarga.
    await new Promise((res, rej) => spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...input,
      "-c:v", "libx264", "-preset", "slow", "-crf", orient === "portrait" ? "23" : "22", "-pix_fmt", "yuv420p",
      "-profile:v", "high", "-movflags", "+faststart", "-an", `${base}.mp4`], { stdio: "inherit" }).on("exit", (c) => (c ? rej(new Error("x264 " + c)) : res())));
    await new Promise((res, rej) => spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...input,
      "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "34", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", "-an", `${base}.webm`], { stdio: "inherit" }).on("exit", (c) => (c ? rej(new Error("vp9 " + c)) : res())));
    await new Promise((res, rej) => spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", path.join(frames, "f0000.png"),
      "-q:v", "5", `${base}-poster.jpg`], { stdio: "inherit" }).on("exit", (c) => (c ? rej(new Error("poster " + c)) : res())));
    fs.rmSync(frames, { recursive: true, force: true });
    for (const ext of [".mp4", ".webm", "-poster.jpg"]) console.log(`${base}${ext}`, fs.statSync(`${base}${ext}`).size);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
