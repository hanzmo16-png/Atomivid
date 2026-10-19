/**
 * Paso 4 (QA de movimiento): renderiza la composición PRODUCTIVA VerticalReel (remotion/index.ts, misma llamada
 * bundle/selectComposition/renderMedia h264 crf 26 que generate-video.ts) con imágenes sintéticas TEXTURIZADAS
 * (testsrc2 + rejilla + ruido) y una dirección por escena conocida, para medir push-in, pan, estático y transiciones.
 * USD 0, sin red: las imágenes y el audio se sirven desde 127.0.0.1.
 *   SYNTH_DIR=<dir con img0..img5.png> OUT=<mp4> npx tsx scripts/harness/e2e/motion-render.ts
 */
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import os from "node:os";
import { bundle } from "@remotion/bundler"; import { renderMedia, selectComposition } from "@remotion/renderer";

function silentWav(seconds: number): Buffer {
  const rate = 48000, n = rate * seconds, b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  return b;
}
export const PLAN = [
  { img: "img0.png", motion: "push_in", tin: "cut", tout: "cut" },
  { img: "img1.png", motion: "pan", tin: "cut", tout: "cut" },
  { img: "img2.png", motion: "static", tin: "cut", tout: "crossfade" },
  { img: "img3.png", motion: "push_in", tin: "crossfade", tout: "fade" },
  { img: "img4.png", motion: "static", tin: "fade", tout: "cut" },
] as const;
export const SHOT = 3;
async function main() {
  const dir = process.env.SYNTH_DIR!, out = process.env.OUT!; const dur = PLAN.length * SHOT;
  const wav = silentWav(dur);
  const srv = http.createServer((req, res) => {
    const f = decodeURIComponent((req.url ?? "/").slice(1));
    if (f === "audio.wav") { res.writeHead(200, { "content-type": "audio/wav", "access-control-allow-origin": "*" }); return res.end(wav); }
    const p = path.join(dir, path.basename(f)); if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*" }); res.end(fs.readFileSync(p));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const inputProps = {
    audioUrl: `${base}/audio.wav`, scenes: PLAN.map((s, i) => ({ mediaUrl: `${base}/${s.img}`, mediaType: "image", startSeconds: i * SHOT, endSeconds: (i + 1) * SHOT,
      direction: { recipeId: "qa-motion",
      // MOTION_RED=1: control negativo — se renderiza push_in/pan como static y crossfade/fade como cut, pero plan.json declara lo pedido ⇒ el QA debe FALLAR.
      motion: process.env.MOTION_RED === "1" ? "static" : s.motion, transitionIn: process.env.MOTION_RED === "1" ? "cut" : s.tin, transitionOut: process.env.MOTION_RED === "1" ? "cut" : s.tout, label: null } })),
    captions: [], narrationGaps: [], durationSeconds: dur, accentColor: "#7c5cff", showLogo: false,
  };
  const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE || undefined;
  const chromeMode = (process.env.REMOTION_CHROME_MODE as "headless-shell" | undefined) || undefined;
  const serveUrl = await bundle({ entryPoint: path.join(process.cwd(), "remotion", "index.ts") });
  const composition = await selectComposition({ serveUrl, id: "VerticalReel", inputProps, browserExecutable, chromeMode });
  await renderMedia({ composition, serveUrl, codec: "h264", outputLocation: out, inputProps, browserExecutable, chromeMode, crf: 26 });
  fs.writeFileSync(out.replace(/\.mp4$/, ".plan.json"), JSON.stringify({ shotSeconds: SHOT, fps: composition.fps, plan: PLAN }, null, 2));
  srv.close(); console.log("OK", out, os.platform());
}
main().catch((e) => { console.error(e); process.exit(1); });
