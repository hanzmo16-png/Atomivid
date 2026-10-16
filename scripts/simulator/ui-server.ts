/**
 * Interfaz local (solo 127.0.0.1) para lanzar el ATOMIVID SIMULATOR V1 desde un navegador.
 *
 * No es parte de la app Next ni se despliega: es un script de desarrollo que reutiliza la CLI ya
 * auditada (`atomivid-simulator.ts`) y las pruebas de Long Form como procesos hijos. No importa
 * Supabase, workers, rutas `/api/generate` ni proveedores; los hijos arrancan con un entorno
 * mínimo (sin claves) y el simulador además borra claves y niega toda red no emulada.
 *
 * Uso:  npm run simulate:ui            → http://127.0.0.1:4319
 *       npm run simulate:ui -- --port=4400 --root=/ruta/fuera/del/repo
 *
 * Todo resultado (página, JSON, informes) lleva la marca BANNER. Nada de lo que se ve aquí es una
 * producción real, un cobro ni un estado `completed` de la cuenta de Hans.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export const BANNER = "SIMULACIÓN / FIXTURE — NO ES PRODUCCIÓN REAL";
export const DEFAULT_PORT = 4319;

export type UiMode = "reel" | "longform" | "avatar" | "longform-600";
export const MODES: Record<UiMode, { label: string; detail: string }> = {
  reel: { label: "Reel", detail: "Pipeline Reel real con proveedores emulados; render 1080x1920 (~1–3 min)." },
  longform: { label: "Long Form", detail: "Pruebas del pipeline Long Form (src/lib/video/long-form, sin render de 600 s)." },
  avatar: { label: "Avatar", detail: "HeyGen y D-ID emulados: ciclo asíncrono, fallos, webhooks (H1/H2) y MP4 de fixture." },
  "longform-600": { label: "Long Form 600 s (manual)", detail: "Render estructural de 600 s a 480x270. Lento (~10–15 min de CPU). Requiere confirmación." },
};

export type Artifact = { file: string; sha256: string; bytes: number; durationSeconds?: number; video?: string };
export type Job = {
  id: string;
  mode: UiMode;
  status: "running" | "passed" | "failed";
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  outDir: string;
  summary?: Record<string, number>;
  scenarios?: { id: string; status: string; title: string; reason: string }[];
  artifacts?: Artifact[];
  zeroPaidControl?: { actualProviderSpendUsd: number; blockedExternalAttempts: number; qa02: string } | null;
  error?: string;
  logTail?: string;
};

type Child = { pid?: number; on(event: "exit", cb: (code: number | null) => void): unknown; stdout: NodeJS.ReadableStream | null; stderr: NodeJS.ReadableStream | null };
export type Runner = (cmd: string, args: string[], opts: { cwd: string; env: Env }) => Child;

/** Se niega a arrancar en cualquier entorno que parezca producción o despliegue. */
export type Env = Record<string, string | undefined>;

export function assertLocalOnly(env: Env = process.env) {
  const bad = ["VERCEL", "VERCEL_ENV", "ATOMIVID_RUNTIME", "GITHUB_ACTIONS"].filter((k) => env[k]);
  if (env.NODE_ENV === "production") bad.push("NODE_ENV=production");
  if (bad.length) throw new Error(`[simulador-ui] negado: entorno no local (${bad.join(", ")})`);
}

/** Entorno de los procesos hijos: sin claves ni variables de proveedores, sólo lo necesario para node/ffmpeg/Chromium. */
export function childEnv(env: Env = process.env): Env {
  const keep = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "REMOTION_BROWSER_EXECUTABLE", "REMOTION_CHROME_MODE", "PLAYWRIGHT_BROWSERS_PATH"];
  const out: Env = { NODE_ENV: "development" };
  for (const k of keep) if (env[k]) out[k] = env[k];
  return out;
}

export function commandFor(mode: UiMode, outDir: string, repo: string): { cmd: string; args: string[] } {
  const sim = (m: string) => ({ cmd: process.execPath, args: ["--import", "tsx", "scripts/simulator/atomivid-simulator.ts", `--mode=${m}`, `--out-dir=${outDir}`] });
  if (mode === "reel") return sim("reel");
  if (mode === "avatar") return sim("avatar");
  if (mode === "longform-600") return sim("youtube");
  const dir = path.join(repo, "src/lib/video/long-form");
  const tests = fs.readdirSync(dir).filter((f) => f.endsWith(".test.ts")).sort().map((f) => path.join("src/lib/video/long-form", f));
  return { cmd: process.execPath, args: ["--import", "tsx", "--test", "--test-reporter=tap", ...tests] };
}

const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Lee el resultado de una corrida terminada (report.json del simulador o salida TAP de las pruebas). */
export function collectResult(job: Job, exitCode: number | null, log: string): Job {
  const done: Job = { ...job, exitCode, finishedAt: new Date().toISOString(), logTail: log.slice(-4000) };
  const reportFile = path.join(job.outDir, "report.json");
  if (job.mode !== "longform" && fs.existsSync(reportFile)) {
    const r = JSON.parse(fs.readFileSync(reportFile, "utf8")) as {
      summary: Record<string, number>;
      zero_paid_controls?: { actual_provider_spend_usd: number; blockedExternalAttempts: unknown[] };
      scenarios: { id: string; status: string; title: string; reason: string; artifacts?: { path: string; sha256: string; bytes: number; ffprobe?: { durationSeconds: number; video?: { codec: string; width: number; height: number } } }[] }[];
    };
    done.summary = r.summary;
    done.scenarios = r.scenarios.map((s) => ({ id: s.id, status: s.status, title: s.title, reason: s.reason }));
    const qa02 = r.scenarios.find((s) => s.id === "QA-02");
    done.zeroPaidControl = { actualProviderSpendUsd: r.zero_paid_controls?.actual_provider_spend_usd ?? -1, blockedExternalAttempts: r.zero_paid_controls?.blockedExternalAttempts?.length ?? -1, qa02: qa02?.status ?? "AUSENTE" };
    const seen = new Set<string>();
    done.artifacts = r.scenarios.flatMap((s) => s.artifacts ?? []).filter((a) => a.path.endsWith(".mp4") && a.path.startsWith(job.outDir) && fs.existsSync(a.path) && !seen.has(a.path) && seen.add(a.path)).map((a) => ({
      file: path.relative(job.outDir, a.path), sha256: a.sha256, bytes: a.bytes, durationSeconds: a.ffprobe?.durationSeconds,
      video: a.ffprobe?.video ? `${a.ffprobe.video.codec} ${a.ffprobe.video.width}x${a.ffprobe.video.height}` : undefined,
    }));
    const ok = exitCode === 0 && (r.summary.FAIL ?? 0) === 0 && done.zeroPaidControl.qa02 === "PASS" && done.zeroPaidControl.actualProviderSpendUsd === 0;
    done.status = ok ? "passed" : "failed";
    if (!ok) done.error = done.zeroPaidControl.qa02 !== "PASS" ? "El control de cero llamadas externas (QA-02) no pasó." : `${r.summary.FAIL ?? 0} escenario(s) en FAIL. Revisa la tabla y el informe.`;
  } else if (job.mode === "longform") {
    const pass = Number(log.match(/^# pass (\d+)/m)?.[1] ?? NaN);
    const fail = Number(log.match(/^# fail (\d+)/m)?.[1] ?? NaN);
    done.summary = { PASS: Number.isNaN(pass) ? 0 : pass, FAIL: Number.isNaN(fail) ? 0 : fail, NOT_VERIFIED: 0 };
    fs.writeFileSync(path.join(job.outDir, "longform-tests.tap.txt"), log);
    done.status = exitCode === 0 && fail === 0 && pass > 0 ? "passed" : "failed";
    if (done.status === "failed") done.error = Number.isNaN(pass) ? "Las pruebas no produjeron un resumen TAP; revisa el registro." : `${fail} prueba(s) de Long Form fallaron.`;
  } else {
    done.status = "failed";
    done.error = `El simulador terminó (código ${exitCode}) sin report.json. Revisa el registro y vuelve a intentarlo.`;
  }
  for (const a of done.artifacts ?? []) if (a.sha256 !== sha256(path.join(job.outDir, a.file))) { done.status = "failed"; done.error = `SHA-256 no coincide para ${a.file}`; }
  return done;
}

export function createUiServer(opts: { repo: string; root: string; runner?: Runner; env?: Env }) {
  assertLocalOnly(opts.env ?? process.env);
  const runner: Runner = opts.runner ?? ((cmd, args, o) => spawn(cmd, args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] }));
  fs.mkdirSync(opts.root, { recursive: true });
  const store = path.join(opts.root, "jobs.json");
  const jobs: Job[] = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, "utf8")) : [];
  // Un proceso interrumpido no deja trabajos "running" eternos tras reiniciar el servidor.
  for (const j of jobs) if (j.status === "running") Object.assign(j, { status: "failed", error: "El servidor se reinició durante la corrida; vuelve a lanzarla." });
  const save = () => fs.writeFileSync(store, JSON.stringify(jobs, null, 2));
  let port = 0;

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-atomivid-simulation": "fixture" });
    res.end(JSON.stringify({ simulation: true, banner: BANNER, ...(body as object) }));
  };

  const start = (mode: UiMode): Job => {
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${mode}`;
    const outDir = path.join(opts.root, id);
    fs.mkdirSync(outDir, { recursive: true });
    const job: Job = { id, mode, status: "running", startedAt: new Date().toISOString(), outDir };
    jobs.unshift(job);
    save();
    const { cmd, args } = commandFor(mode, outDir, opts.repo);
    let log = "";
    const child = runner(cmd, args, { cwd: opts.repo, env: childEnv(opts.env ?? process.env) });
    child.stdout?.on("data", (d) => { log += d; });
    child.stderr?.on("data", (d) => { log += d; });
    child.on("exit", (code) => {
      fs.writeFileSync(path.join(outDir, "run.log"), log);
      Object.assign(job, collectResult(job, code, log));
      save();
    });
    return job;
  };

  const server = http.createServer(async (req, res) => {
    // Solo loopback y Host exacto (evita DNS rebinding desde otra página del navegador).
    const host = req.headers.host ?? "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "") || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) {
      res.writeHead(403); res.end("forbidden"); return;
    }
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; media-src 'self'; connect-src 'self'" });
      res.end(page()); return;
    }
    if (req.method === "GET" && url.pathname === "/api/jobs") return send(res, 200, { jobs: jobs.map(publicJob) });
    if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
      const j = jobs.find((x) => x.id === decodeURIComponent(url.pathname.slice("/api/jobs/".length)));
      return j ? send(res, 200, { job: publicJob(j) }) : send(res, 404, { error: "No existe esa corrida." });
    }
    if (req.method === "POST" && url.pathname === "/api/jobs") {
      if (req.headers["content-type"] !== "application/json") return send(res, 415, { error: "Se espera JSON." });
      let raw = "";
      for await (const c of req) { raw += c; if (raw.length > 2048) return send(res, 413, { error: "Petición demasiado grande." }); }
      let body: { mode?: string; confirm600?: string };
      try { body = JSON.parse(raw || "{}"); } catch { return send(res, 400, { error: "JSON no válido." }); }
      const mode = body.mode as UiMode;
      if (!(mode in MODES)) return send(res, 400, { error: "Modo desconocido. Usa reel, longform, avatar o longform-600." });
      if (mode === "longform-600" && body.confirm600 !== "600") return send(res, 400, { error: "El render de 600 s exige confirmación explícita (confirm600: \"600\")." });
      const running = jobs.find((j) => j.status === "running");
      if (running) return send(res, 409, { error: `Ya hay una simulación en curso (${MODES[running.mode].label}). Espera a que termine; no se lanzó otra.`, job: publicJob(running) });
      return send(res, 202, { job: publicJob(start(mode)) });
    }
    if (req.method === "GET" && url.pathname.startsWith("/files/")) {
      const [, , id, ...rest] = url.pathname.split("/");
      const j = jobs.find((x) => x.id === decodeURIComponent(id ?? ""));
      const rel = decodeURIComponent(rest.join("/"));
      const file = j ? path.resolve(j.outDir, rel) : "";
      const allowed = j && file.startsWith(j.outDir + path.sep) && /\.(mp4|json|md|txt|log)$/.test(file) && fs.existsSync(file) && fs.statSync(file).isFile();
      if (!allowed) { res.writeHead(404); res.end("not found"); return; }
      const type = file.endsWith(".mp4") ? "video/mp4" : file.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8";
      res.writeHead(200, { "content-type": type, "content-length": fs.statSync(file).size, "x-atomivid-simulation": "fixture", ...(url.searchParams.has("download") ? { "content-disposition": `attachment; filename="SIMULACION-${path.basename(file)}"` } : {}) });
      fs.createReadStream(file).pipe(res); return;
    }
    send(res, 404, { error: "Ruta no encontrada." });
  });

  return {
    server,
    jobs,
    listen: (p: number) => new Promise<number>((resolve) => server.listen(p, "127.0.0.1", () => { port = (server.address() as { port: number }).port; resolve(port); })),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const publicJob = (j: Job) => ({ ...j, outDir: undefined, label: MODES[j.mode].label, banner: BANNER });

function page() {
  const modes = Object.entries(MODES).map(([k, m]) => `<button data-mode="${k}"${k === "longform-600" ? ' class="slow"' : ""}>${m.label}</button><small>${m.detail}</small>`).join("");
  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${BANNER} · Simulador ATOMIVID</title>
<style>
body{font:15px system-ui,sans-serif;margin:0;background:#f6f6f4;color:#1b1b1b}
.banner{background:#b00020;color:#fff;font-weight:700;text-align:center;padding:10px 16px;position:sticky;top:0;letter-spacing:.02em}
main{max-width:960px;margin:0 auto;padding:16px}
.modes{display:grid;grid-template-columns:max-content 1fr;gap:8px 12px;align-items:center;margin:16px 0}
button{font:inherit;padding:8px 16px;border:1px solid #333;border-radius:6px;background:#fff;cursor:pointer}
button.slow{border-style:dashed}
button:disabled{opacity:.5;cursor:not-allowed}
.msg{min-height:1.4em;color:#8a1c00}
.job{background:#fff;border:1px solid #ccc;border-radius:8px;padding:12px;margin:12px 0}
.job h3{margin:0 0 6px} .running{color:#8a5a00} .passed{color:#0b6b2b} .failed{color:#b00020}
table{border-collapse:collapse;width:100%;font-size:13px} td,th{border-top:1px solid #eee;padding:4px;text-align:left;vertical-align:top}
video{width:100%;max-width:360px;background:#000;display:block;margin:6px 0}
code{word-break:break-all}
pre{white-space:pre-wrap;max-height:160px;overflow:auto;background:#f0f0f0;padding:6px;font-size:12px}
</style>
<div class="banner" id="banner">${BANNER}</div>
<main>
<h1>Simulador ATOMIVID (local)</h1>
<p>Solo fixtures sintéticos y proveedores emulados en este equipo. USD 0. No usa tu cuenta, no escribe en producción y no cobra. Un resultado «PASS» aquí <strong>no</strong> es una producción real.</p>
<div class="modes">${modes}</div>
<p class="msg" id="msg" role="status"></p>
<div id="jobs"></div>
</main>
<script>
const $=s=>document.querySelector(s);const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
async function launch(mode){
  const body={mode};
  if(mode==="longform-600"){if(!confirm("El render de 600 s tarda unos 10–15 minutos de CPU en este equipo. Es una simulación, sin coste. ¿Continuar?"))return;body.confirm600="600";}
  document.querySelectorAll("button[data-mode]").forEach(b=>b.disabled=true);
  const r=await fetch("/api/jobs",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const j=await r.json();$("#msg").textContent=r.ok?"Simulación iniciada: "+j.job.label:j.error;refresh();
}
document.querySelectorAll("button[data-mode]").forEach(b=>b.onclick=()=>launch(b.dataset.mode));
function render(j){
  const sc=(j.scenarios||[]).map(s=>"<tr><td>"+esc(s.id)+"</td><td class='"+(s.status==="PASS"?"passed":s.status==="FAIL"?"failed":"running")+"'>"+esc(s.status)+"</td><td>"+esc(s.title)+(s.status==="PASS"?"":"<br><small>"+esc(s.reason)+"</small>")+"</td></tr>").join("");
  const vids=(j.artifacts||[]).map(a=>{const u="/files/"+encodeURIComponent(j.id)+"/"+a.file.split("/").map(encodeURIComponent).join("/");return "<div><video controls preload='metadata' src='"+u+"'></video><small>"+esc(a.file)+" · "+esc(a.video)+" · "+(a.durationSeconds??"?")+" s · "+a.bytes+" B<br>SHA-256 <code>"+esc(a.sha256)+"</code><br><a href='"+u+"?download=1'>Descargar (SIMULACION)</a></small></div>";}).join("");
  const sum=j.summary?Object.entries(j.summary).map(([k,v])=>k+" "+v).join(" · "):"";
  const zp=j.zeroPaidControl?"Control USD 0: gasto real "+j.zeroPaidControl.actualProviderSpendUsd+" USD · intentos externos "+j.zeroPaidControl.blockedExternalAttempts+" · QA-02 "+j.zeroPaidControl.qa02:"";
  const rep=j.status!=="running"?(j.mode==="longform"?"<a href='/files/"+encodeURIComponent(j.id)+"/longform-tests.tap.txt'>Salida de pruebas</a>":"<a href='/files/"+encodeURIComponent(j.id)+"/report.md'>Informe (report.md)</a> · <a href='/files/"+encodeURIComponent(j.id)+"/report.json'>report.json</a>")+" · <a href='/files/"+encodeURIComponent(j.id)+"/run.log'>registro</a>":"";
  return "<div class='job' data-status='"+j.status+"'><h3>"+esc(j.label)+" — <span class='"+j.status+"'>"+({running:"en curso…",passed:"terminado (simulado)",failed:"con fallos"}[j.status])+"</span></h3><small>"+esc(j.banner)+" · inicio "+esc(j.startedAt)+(j.finishedAt?" · fin "+esc(j.finishedAt):"")+"</small>"+
   (j.error?"<p class='failed'>"+esc(j.error)+" <button data-retry='"+esc(j.mode)+"'>Reintentar</button></p>":"")+
   "<p>"+esc(sum)+(zp?"<br>"+esc(zp):"")+"</p>"+(sc?"<table><tr><th>ID</th><th>Estado</th><th>Escenario</th></tr>"+sc+"</table>":"")+vids+"<p>"+rep+"</p>"+(j.status==="failed"&&j.logTail?"<pre>"+esc(j.logTail.slice(-1500))+"</pre>":"")+"</div>";
}
async function refresh(){
  const r=await fetch("/api/jobs");const d=await r.json();
  $("#jobs").innerHTML=d.jobs.map(render).join("")||"<p>Sin corridas todavía.</p>";
  document.querySelectorAll("[data-retry]").forEach(b=>b.onclick=()=>launch(b.dataset.retry));
  const busy=d.jobs.some(j=>j.status==="running");
  document.querySelectorAll("button[data-mode]").forEach(b=>b.disabled=busy);
  if(busy)setTimeout(refresh,2000);
}
refresh();
</script></html>`;
}

if (require.main === module) {
  const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const repo = path.resolve(__dirname, "../..");
  const root = path.resolve(arg("root") ?? path.join(os.tmpdir(), "atomivid-sim-ui"));
  if (root.startsWith(repo + path.sep) || root === repo) throw new Error("[simulador-ui] --root debe estar fuera del repositorio");
  const ui = createUiServer({ repo, root });
  ui.listen(Number(arg("port") ?? DEFAULT_PORT)).then((p) => console.log(`[simulador-ui] ${BANNER}\n  http://127.0.0.1:${p}  (solo este equipo)\n  resultados en ${root}`));
}
