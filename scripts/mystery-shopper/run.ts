/**
 * Worker del modo gratuito. Genera archivos de prueba, abre el arnés y recorre la interfaz.
 * No usa secretos ni proveedores. El modo real se rechaza aquí mismo.
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import { validateMedia } from "../../src/lib/mystery-shopper/media";
import { reportFromJourney } from "../../src/lib/mystery-shopper/evaluate";
import type { Journey, ProductId } from "../../src/lib/mystery-shopper/types";

const exec = promisify(execFile);

function wav(seconds = 2): Buffer {
  const sampleRate = 8000;
  const n = sampleRate * seconds;
  const data = Buffer.alloc(44 + n * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + n * 2, 4);
  data.write("WAVE", 8);
  data.write("fmt ", 12);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(sampleRate, 24);
  data.writeUInt32LE(sampleRate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 6000), 44 + i * 2);
  return data;
}

async function mp3(wavPath: string, out: string) {
  await exec(ffmpeg.path, ["-y", "-i", wavPath, "-codec:a", "libmp3lame", "-q:a", "9", out], { timeout: 20000 });
}
async function mp4(wavPath: string, out: string, size: string) {
  await exec(ffmpeg.path, ["-y", "-i", wavPath, "-f", "lavfi", "-i", `color=c=0x224466:s=${size}:d=2:r=10`, "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", out], { timeout: 30000 });
}

function waitReady(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    child.stdout?.on("data", (chunk) => {
      buf += String(chunk);
      const match = buf.match(/READY (\d+)/);
      if (match) resolve(match[1]);
    });
    child.on("exit", (code) => reject(new Error(`El arnés terminó (${code ?? "sin código"}) antes de estar listo.`)));
  });
}

async function shaOfRepo(): Promise<string> {
  if (process.env.MS_SHA) return process.env.MS_SHA;
  try {
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], { timeout: 5000 });
    return stdout.trim();
  } catch {
    return "desconocido";
  }
}

export async function runFixtureWalk(root = process.cwd()): Promise<{ journeys: Journey[]; reportPath: string }> {
  if (process.env.MS_MODE === "real") throw new Error("El worker rechaza el modo real. No se ejecutó ningún proveedor.");
  const dir = path.join(tmpdir(), `mystery-shopper-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const tone = path.join(dir, "tone.wav");
  const audio = path.join(dir, "flannan-fixture.mp3");
  const video = path.join(dir, "oceano-fixture.mp4");
  const reel = path.join(dir, "reel-fixture.mp4");
  const long = path.join(dir, "nazca-fixture.mp4");
  await writeFile(tone, wav());
  await mp3(tone, audio);
  await mp4(tone, video, "320x180");
  await mp4(tone, reel, "180x320");
  await mp4(tone, long, "320x180");
  const out = path.join(dir, "out");
  await mkdir(out, { recursive: true });
  const harness = spawn(process.execPath, [path.join(root, "scripts/mystery-shopper/harness.mjs")], {
    env: { ...process.env, MS_AUDIO: audio, MS_VIDEO: video, MS_REEL: reel, MS_LONG: long },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let port: string;
  try {
    port = await waitReady(harness);
    const sha = await shaOfRepo();
    await new Promise<void>((resolve, reject) => {
      const walk = spawn(process.execPath, [path.join(root, "scripts/mystery-shopper/walk.mjs")], {
        env: { ...process.env, MS_BASE: `http://127.0.0.1:${port}`, MS_OUT: out, MS_SHA: sha, MS_PUBLIC_URL: process.env.MS_PUBLIC_URL ?? "https://atomivid.vercel.app/login" },
        stdio: ["ignore", "inherit", "inherit"],
      });
      walk.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`El recorrido terminó con código ${code}`)));
    });
    const parsed = JSON.parse(await readFile(path.join(out, "journeys.json"), "utf8")) as { journeys: Journey[] };
    const files: Partial<Record<ProductId, string>> = { "audio-podcast": audio, "video-podcast": video, reels: reel, "long-form": long };
    const measured: Partial<Record<ProductId, Awaited<ReturnType<typeof validateMedia>>>> = {};
    for (const [product, file] of Object.entries(files) as [ProductId, string][]) measured[product] = await validateMedia(file, { labeledFixture: true });
    for (const journey of parsed.journeys) {
      journey.mediaByProduct = { ...measured };
      const own = journey.products[0]?.product;
      journey.media = (own && measured[own]) || measured["audio-podcast"] || null;
      journey.spendUsd = 0;
    }
    const recordedDir = path.join(root, "src/lib/mystery-shopper/recorded");
    await mkdir(recordedDir, { recursive: true });
    await writeFile(path.join(recordedDir, "journeys.json"), JSON.stringify({ journeys: parsed.journeys }, null, 2));
    const audioJourney = parsed.journeys.find((j) => j.missionId === "audio-flannan");
    if (!audioJourney) throw new Error("El recorrido no devolvió la misión de audio.");
    const now = new Date().toISOString();
    const report = reportFromJourney({
      id: `fixture-${sha.slice(0, 12)}-audio-flannan`,
      idempotencyKey: `fixture-${sha.slice(0, 12)}-audio-flannan`,
      mode: "fixture",
      product: "audio-podcast",
      profile: "principiante",
      missionId: "audio-flannan",
      instructions: "Islas Flannan, en español, 10 minutos, 2 voces y música ambiental.",
      startedAt: now,
      finishedAt: now,
      maxBudgetUsd: 0,
      realMode: { executed: false, code: "fixture", reason: "Modo gratuito. Gasto USD 0." },
      journey: audioJourney,
    });
    const evidenceDir = path.join(root, "artifacts/mystery-shopper/evidence");
    await mkdir(evidenceDir, { recursive: true });
    for (const name of ["audio-390.png", "audio-412.png", "atomivid-login-390.png"]) {
      await copyFile(path.join(out, name), path.join(evidenceDir, name)).catch(() => undefined);
    }
    const reportPath = path.join(root, "artifacts/mystery-shopper/informe-audio.json");
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    if (report.spendUsd !== 0) throw new Error("El recorrido fixture gastó dinero.");
    return { journeys: parsed.journeys, reportPath };
  } finally {
    harness.kill("SIGTERM");
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const isMain = process.argv[1]?.includes("mystery-shopper/run");
if (isMain) {
  runFixtureWalk().then((r) => { console.log("RUN_OK", r.reportPath); }).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
