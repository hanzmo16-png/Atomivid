// Mock local de Pexels (USD 0, sin red): búsquedas de video/foto devuelven medios generados localmente con ffmpeg.
// Rutas: /videos/search, /v1/search, /media/<archivo>. Registra cada llamada en MOCK_LOG (jsonl).
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import { execFileSync } from "node:child_process";
const PORT = Number(process.env.MOCK_PEXELS_PORT || 54872), DIR = process.env.MOCK_MEDIA_DIR, LOG = process.env.MOCK_LOG;
fs.mkdirSync(DIR, { recursive: true });
const COLORS = ["0x264653", "0x2a9d8f", "0xe9c46a", "0xf4a261", "0xe76f51", "0x457b9d"];
COLORS.forEach((c, i) => {
  const v = path.join(DIR, `clip${i}.mp4`), p = path.join(DIR, `foto${i}.jpg`);
  if (!fs.existsSync(v)) execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=1920x1080:r=25:d=12,hue=h=${i * 60}`, "-f", "lavfi", "-i", `color=c=${c}:s=1920x1080:d=12`, "-filter_complex", "[0][1]blend=all_mode=overlay:all_opacity=0.5,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", v]);
  if (!fs.existsSync(p)) execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${c}:s=1920x1080,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='MEDIO LOCAL ${i}':fontcolor=white:fontsize=90:x=(w-tw)/2:y=(h-th)/2`, "-frames:v", "1", p]);
});
const log = (o) => LOG && fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n");
let n = 0;
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/videos/search") {
    const k = n++ % COLORS.length; log({ kind: "video_search", q: u.searchParams.get("query") });
    return res.end(JSON.stringify({ videos: [{ id: 1000 + k, duration: 12, url: `https://www.pexels.com/video/mock-local-${k}/`, user: { name: "Medio local de prueba" },
      video_files: [{ link: `https://videos.pexels.com/media/clip${k}.mp4`, width: 1920, height: 1080, quality: "hd", file_type: "video/mp4" }] }] }));
  }
  if (u.pathname === "/v1/search") {
    const k = n++ % COLORS.length; log({ kind: "photo_search", q: u.searchParams.get("query") });
    return res.end(JSON.stringify({ photos: [{ id: 2000 + k, width: 1920, height: 1080, src: { large2x: `https://images.pexels.com/media/foto${k}.jpg` }, photographer: "Medio local de prueba", url: `https://www.pexels.com/photo/mock-local-${k}/` }] }));
  }
  const m = /^\/media\/([\w.]+)$/.exec(u.pathname);
  if (m && fs.existsSync(path.join(DIR, m[1]))) { log({ kind: "download", file: m[1] }); res.setHeader("content-type", m[1].endsWith(".mp4") ? "video/mp4" : "image/jpeg"); return fs.createReadStream(path.join(DIR, m[1])).pipe(res); }
  res.statusCode = 404; res.end("{}");
}).listen(PORT, "127.0.0.1", () => console.log(`mock-pexels ${PORT}`));
