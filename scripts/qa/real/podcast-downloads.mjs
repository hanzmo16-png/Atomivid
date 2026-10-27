// USD 0: desde la cuenta del dueño, descarga MP4 y MP3 de un episodio «ready» del estudio con los enlaces de
// «Tus episodios», compara cada archivo con el guardado (sha256), los decodifica completos y reproduce el audio en el
// navegador. No autoriza, no genera, no escribe en producción. Hechos no sensibles en $EVID/facts.json (cifrado después).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const APP = process.env.APP_URL || "https://atomivid.vercel.app";
const EP = process.env.RETRY_EPISODE_ID || "", OWNER = process.env.OWNER_ID, EVID = process.env.EVID;
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let fails = 0; const facts = { episode: EP };
const ok = (name, cond, info = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name}${info ? ` — ${info}` : ""}`); if (!cond) fails++; return cond; };
fs.mkdirSync(EVID, { recursive: true });
const done = () => { fs.writeFileSync(path.join(EVID, "facts.json"), JSON.stringify(facts, null, 1)); console.log(`RESULT podcast-downloads: ${fails} FAIL`); process.exit(fails ? 1 : 0); };

const { data: ep } = await db.from("podcast_studio_episodes").select("id,user_id,status,video_path,audio_path,cost_usd").eq("id", EP).maybeSingle();
if (!ok("episode is the owner's and ready", !!ep && ep.user_id === OWNER && ep.status === "ready", ep?.status)) done();
facts.costUsd = ep.cost_usd;
const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || undefined });
const ctx = await browser.newContext({ storageState: process.env.STATE_FILE, viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const dismiss = async () => { for (const n of ["Omitir", "Cerrar", "Entendido", "Saltar"]) await p.getByRole("button", { name: n, exact: true }).first().click({ timeout: 2500 }).catch(() => {}); await p.keyboard.press("Escape").catch(() => {}); };
await p.goto(`${APP}/dashboard/podcast`); await dismiss();
ok("owner session opens the studio", !/\/login/.test(p.url()), new URL(p.url()).pathname);
const card = p.getByTestId(`studio-episode-${EP}`);
if (!ok("episode listed in «Tus episodios»", await card.waitFor({ timeout: 60000 }).then(() => true, () => false))) { await browser.close(); done(); }
await p.screenshot({ path: path.join(EVID, "descargas-lista.png"), fullPage: true }).catch(() => {});

for (const [kind, testid, stored, ext] of [["mp4", "studio-download-mp4", ep.video_path, ".mp4"], ["mp3", "studio-download-audio", ep.audio_path, ".mp3"]]) {
  const href = await card.getByTestId(testid).getAttribute("href").catch(() => null);
  if (!ok(`${kind}: download link shown in the account`, !!href && stored?.endsWith(ext))) continue;
  const res = await fetch(href); const buf = Buffer.from(await res.arrayBuffer());
  const file = path.join(EVID, "..", `descarga-p2${ext}`); fs.writeFileSync(file, buf);
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  const { data: blob } = await db.storage.from("videos").download(stored);
  const sha2 = blob ? crypto.createHash("sha256").update(Buffer.from(await blob.arrayBuffer())).digest("hex") : null;
  facts[kind] = { http: res.status, bytes: buf.length, sha256: sha, type: res.headers.get("content-type") };
  ok(`${kind}: download == stored file (sha256)`, res.ok && sha === sha2, `${buf.length} bytes`);
  const pr = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,format_name:stream=codec_type,codec_name", "-of", "json", file]).toString());
  facts[kind].media = pr;
  const hasV = pr.streams.some((s) => s.codec_type === "video"), hasA = pr.streams.some((s) => s.codec_type === "audio");
  ok(`${kind}: streams`, kind === "mp4" ? hasV && hasA : hasA && !hasV, `${pr.format.format_name} ${pr.format.duration}s ${pr.streams.map((s) => s.codec_name).join("/")}`);
  ok(`${kind}: full decode without errors`, spawnSync("ffmpeg", ["-v", "error", "-xerror", "-i", file, "-f", "null", "-"]).status === 0);
  if (kind === "mp3") {
    const play = await p.evaluate(async (u) => { const a = new Audio(u); a.muted = true; await a.play().catch(() => {}); await new Promise((r) => setTimeout(r, 4000)); const o = { rs: a.readyState, t: a.currentTime, d: a.duration, err: a.error?.code ?? null }; a.pause(); return o; }, href);
    ok("mp3: plays in the browser from the account link", play.rs >= 2 && play.t > 0.5 && !play.err, JSON.stringify(play));
  }
}
await browser.close(); done();
