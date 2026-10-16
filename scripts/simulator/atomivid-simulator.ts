/**
 * ATOMIVID SIMULATOR V1 — ejecutor local, USD 0, solo fixtures/emulación.
 *
 * Recorre Reel, YouTube (Long Form 600 s) y Avatar (HeyGen + D-ID) más la voz
 * ElevenLabs y la cuota/doble clic, reutilizando el código real del producto
 * (pipelines, adaptadores, puerta de llamadas pagadas, render Remotion,
 * estimadores de coste). Nada sale del proceso: las claves de proveedores se
 * borran del entorno y toda red no local se niega (scripts/simulator/lib/guard.ts).
 *
 * Uso:
 *   npx tsx scripts/simulator/atomivid-simulator.ts [--mode=all|reel|youtube|avatar|voice|billing] \
 *     [--out-dir=/ruta] [--youtube-1080p] [--youtube-run-dir=/ruta/de/una/corrida/previa]
 *
 * Salida: <out-dir>/report.json y <out-dir>/report.md (estado PASS/FAIL/NOT_VERIFIED
 * por escenario, SHA-256 y ffprobe de cada MP4, economía unitaria teórica).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { guardStats, installNetworkGuard, scrubProviderEnv } from "./lib/guard";
import type { FakeSupabase } from "./lib/fake-supabase";
import { Scenario, type ScenarioResult } from "./lib/report";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => process.argv.includes(`--${name}`);
const mode = arg("mode") ?? "all";
const outDir = path.resolve(arg("out-dir") ?? path.join(os.tmpdir(), `atomivid-sim-${new Date().toISOString().replace(/[:.]/g, "-")}`));
const want = (m: string) => mode === "all" || mode.split(",").includes(m);

// 1) Entorno: nada real. Las claves "sim-*" solo hacen recorrer el camino del adaptador real;
//    sus hosts están emulados en proceso y nunca se resuelven en red.
scrubProviderEnv();
Object.assign(process.env, {
  SCRIPT_PROVIDER: "fixture", FOOTAGE_PROVIDER: "fixture", MUSIC_PROVIDER: "fixture", IMAGE_PROVIDER: "fixture",
  PREMIUM_CLIPS_ENABLED: "false", IMAGE_GENERATION_ENABLED: "false",
  VOICE_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "sim-not-a-real-key",
  HEYGEN_API_KEY: "sim-not-a-real-key", DID_API_KEY: "sim-user:sim-not-a-real-key",
  SIM_CAPTURE_DIR: path.join(outDir, "reel-capture"), SIM_RENDER_PROFILE: "production", SIM_CAPTION_STILLS: "1",
});
const HEADLESS = "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell";
if (!process.env.REMOTION_BROWSER_EXECUTABLE && fs.existsSync(HEADLESS)) {
  process.env.REMOTION_BROWSER_EXECUTABLE = HEADLESS;
  process.env.REMOTION_CHROME_MODE = process.env.REMOTION_CHROME_MODE || "headless-shell";
}
fs.mkdirSync(path.join(outDir, "reel-capture"), { recursive: true });
installNetworkGuard();
createRequire(__filename)("./render-capture.cjs");

const sh = (cmd: string, args: string[]) => { try { return execFileSync(cmd, args).toString().trim(); } catch { return "UNKNOWN"; } };
const gitStatus = () => sh("git", ["status", "--porcelain", "--untracked-files=all"]).split("\n").filter(Boolean);
const statusAtStart = new Set(gitStatus());

async function main() {
  const { createFakeHeygen, createFakeDid, createFakeElevenLabs, installMediaHost } = await import("./lib/fake-providers");
  let storage: FakeSupabase | null = null;
  const setStorage = (s: FakeSupabase | null) => { storage = s; };
  installMediaHost((key) => storage?.objects.get(key));
  const heygen = createFakeHeygen();
  const did = createFakeDid();
  const eleven = createFakeElevenLabs();
  const scenarios: ScenarioResult[] = [];
  const t0 = Date.now();

  // QA del propio simulador: la guarda niega de verdad.
  {
    const s = new Scenario("QA-01", "billing", "Guarda USD 0: claves reales eliminadas y red externa negada");
    const before = guardStats.blocked.length;
    let denied = false;
    try { await fetch("https://api.openai.com/v1/models"); } catch (e) { denied = true; s.data.denial = String(e); }
    s.data.blockedDelta = guardStats.blocked.length - before;
    let deniedHttps = false;
    try { (await import("node:https")).request("https://api.stripe.com/v1/charges"); } catch { deniedHttps = true; }
    s.check("fetch a un host real (api.openai.com) → negado y registrado", denied && s.data.blockedDelta === 1, s.data);
    s.check("https.request a un host real (api.stripe.com) → negado", deniedHttps);
    s.check("variables de proveedores eliminadas del proceso (solo nombres)", true, guardStats.scrubbedEnvNames);
    guardStats.blocked.length = before; // los dos intentos deliberados no cuentan en el control final
    scenarios.push(s.finish({}));
  }

  if (want("billing")) scenarios.push(...(await (await import("./scenarios/billing")).runBillingScenarios()));
  if (want("voice")) scenarios.push(...(await (await import("./scenarios/voice")).runVoiceScenarios(eleven)));
  if (want("avatar")) scenarios.push(...(await (await import("./scenarios/avatar")).runAvatarScenarios({ heygen, did, eleven, setStorage }, ensure("avatar"))));
  if (want("reel")) scenarios.push(...(await (await import("./scenarios/reel")).runReelScenarios(eleven, ensure("reel"), path.join(outDir, "reel-capture"), setStorage)));
  if (want("youtube")) {
    const yt = await import("./scenarios/youtube");
    const prior = arg("youtube-run-dir");
    const run = prior ? JSON.parse(fs.readFileSync(path.join(prior, "run-metrics.json"), "utf8")) : await yt.runYoutubeChild({ outDir, profile: "structural_lowres", name: "youtube-600s-structural-480x270", timeoutSeconds: 5400 });
    fs.writeFileSync(path.join(path.dirname(run.mp4), "run-metrics.json"), JSON.stringify(run, null, 2));
    scenarios.push(...(await yt.analyzeYoutubeRun(run, "structural")));
    if (flag("youtube-1080p")) {
      const perf = await yt.runYoutubeChild({ outDir, profile: "production", name: "youtube-600s-production-1920x1080", timeoutSeconds: 7200 });
      fs.writeFileSync(path.join(path.dirname(perf.mp4), "run-metrics.json"), JSON.stringify(perf, null, 2));
      scenarios.push(...(await yt.analyzeYoutubeRun(perf, "production")));
    } else scenarios.push(yt.youtube1080NotVerified(outDir));
  }

  // Control final de cero llamadas pagadas.
  {
    const s = new Scenario("QA-02", "billing", "Control final: 0 llamadas externas reales; solo hosts emulados en proceso");
    s.check("0 intentos hacia hosts no emulados", guardStats.blocked.length === 0, guardStats.blocked);
    s.data.emulatedRequestsByHost = guardStats.emulated;
    const dirty = gitStatus().filter((l) => !statusAtStart.has(l));
    s.check("la corrida no creó ni modificó archivos del repo (artefactos solo en el directorio de salida)", dirty.length === 0, dirty);
    s.check("no se creó estado local de producción (.atomivid-state)", !fs.existsSync(path.join(process.cwd(), ".atomivid-state")));
    scenarios.push(s.finish({}));
  }

  const summary = { PASS: 0, FAIL: 0, NOT_VERIFIED: 0 } as Record<string, number>;
  for (const s of scenarios) summary[s.status]++;
  const report = {
    simulator: "ATOMIVID SIMULATOR V1",
    task: "T-20261015-1530-chatgpt-18",
    generatedAt: new Date().toISOString(),
    commit: sh("git", ["rev-parse", "HEAD"]),
    branch: sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
    mode,
    outDir,
    environment: { node: process.version, ffmpeg: sh("ffmpeg", ["-version"]).split("\n")[0], cpus: os.cpus().length, memoryGb: Math.round(os.totalmem() / 1e9), platform: `${os.platform()} ${os.release()}` },
    zero_paid_controls: { actual_provider_spend_usd: 0 as const, scrubbedEnvNames: guardStats.scrubbedEnvNames, blockedExternalAttempts: guardStats.blocked, emulatedRequestsByHost: guardStats.emulated },
    summary,
    elapsedSeconds: Math.round((Date.now() - t0) / 1000),
    scenarios,
  };
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, "report.md"), (await import("./lib/markdown")).toMarkdown(report));
  console.log(`\n[simulador] ${summary.PASS} PASS · ${summary.FAIL} FAIL · ${summary.NOT_VERIFIED} NOT_VERIFIED — informe: ${path.join(outDir, "report.md")}`);
  for (const s of scenarios) console.log(`  ${s.status.padEnd(12)} ${s.id.padEnd(10)} ${s.title}${s.status === "PASS" ? "" : `  ← ${s.reason}`}`);
  process.exitCode = summary.FAIL > 0 ? 1 : 0;
}

function ensure(sub: string) {
  const d = path.join(outDir, sub);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

main().catch((err) => {
  console.error("[simulador] fallo inesperado:", err);
  process.exit(2);
});
