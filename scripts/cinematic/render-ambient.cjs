#!/usr/bin/env node
/**
 * Renderiza un ambiente cinematográfico propio (USD 0): abre la escena HTML en Chromium, dibuja cada fotograma con
 * draw(t) determinista, lo captura como PNG y lo codifica con ffmpeg (H.264 + WebM VP9) más un póster JPEG.
 *
 *   node scripts/cinematic/render-ambient.cjs <escena> <outDir> [prefijo]
 *   THREE_DIR=<ruta a node_modules/three>   (solo escenas 3D; three no es dependencia de la app)
 *
 * <escena> es scripts/cinematic/<escena>-scene.html. La escena expone setup(w,h) (puede ser asíncrono), draw(t) y
 * window.LOOP_SECONDS. Se sirve por HTTP local (los módulos ES no cargan desde file://).
 * Salida: <prefijo>-<orient>.mp4 / .webm / -poster.jpg para landscape (1280×720) y portrait (720×1280).
 */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const id = process.argv[2] || "cosmos";
const out = path.resolve(process.argv[3] || "public/cinematic");
const prefix = process.argv[4] || id;
const http = require("node:http");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json" };
function serve() {
  return new Promise((res) => { const srv = http.createServer((q, r) => {
    const u = decodeURIComponent(new URL(q.url, "http://x").pathname);
    const f = u.startsWith("/three/") ? path.join(process.env.THREE_DIR || "", u.slice(7)) : path.join(__dirname, u);
    fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" }); r.end(b); }); });
    srv.listen(0, "127.0.0.1", () => res(srv)); });
}
const FFMPEG = process.env.FFMPEG || require("@ffmpeg-installer/ffmpeg").path;
const FPS = 24;
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
  const srv = await serve(); const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch();
  for (const [orient, [w, h]] of Object.entries(SIZES)) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await page.goto(`${base}/${id}-scene.html`);
    await page.waitForFunction(() => typeof window.setup === "function", null, { timeout: 60000 });
    await page.evaluate(([w, h]) => window.setup(w, h), [w, h]);
    const LOOP = await page.evaluate(() => window.LOOP_SECONDS || 8);
    const frames = path.join(out, `.frames-${prefix}-${orient}`);
    fs.mkdirSync(frames, { recursive: true });
    const n = FPS * LOOP;
    for (let i = 0; i < n; i++) {
      const b64 = await page.evaluate((t) => { window.draw(t); return document.querySelector("canvas").toDataURL("image/png").slice(22); }, i / FPS);
      fs.writeFileSync(path.join(frames, `f${String(i).padStart(4, "0")}.png`), Buffer.from(b64, "base64"));
    }
    await page.close();
    const input = ["-framerate", String(FPS), "-i", path.join(frames, "f%04d.png")];
    const dst = path.join(out, `${prefix}-${orient}`);
    // H.264: compatible con todo; faststart para empezar a reproducir antes de terminar la descarga.
    await new Promise((res, rej) => spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...input,
      "-c:v", "libx264", "-preset", "slow", "-crf", orient === "portrait" ? "23" : "22", "-pix_fmt", "yuv420p",
      "-profile:v", "high", "-movflags", "+faststart", "-an", `${dst}.mp4`], { stdio: "inherit" }).on("exit", (c) => (c ? rej(new Error("x264 " + c)) : res())));
    await new Promise((res, rej) => spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...input,
      "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "34", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", "-an", `${dst}.webm`], { stdio: "inherit" }).on("exit", (c) => (c ? rej(new Error("vp9 " + c)) : res())));
    await new Promise((res, rej) => spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", path.join(frames, "f0000.png"),
      "-q:v", "5", `${dst}-poster.jpg`], { stdio: "inherit" }).on("exit", (c) => (c ? rej(new Error("poster " + c)) : res())));
    fs.rmSync(frames, { recursive: true, force: true });
    for (const ext of [".mp4", ".webm", "-poster.jpg"]) console.log(`${dst}${ext}`, fs.statSync(`${dst}${ext}`).size);
  }
  await browser.close(); srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
