// Worker de prueba: recibe el client_payload que la ruta /render envió a "GitHub" y ejecuta el entrypoint productivo
// scripts/render-worker.ts como proceso aparte contra el gateway local. Registra cada despacho y su salida.
import http from "node:http"; import fs from "node:fs"; import { spawn } from "node:child_process"; import path from "node:path";
const ROOT = process.env.APP_ROOT, LOGDIR = process.env.LOGDIR, REG = path.join(LOGDIR, "dispatches.jsonl");
const override = () => { try { return JSON.parse(fs.readFileSync(path.join(LOGDIR, "worker-env-override.json"), "utf8")); } catch { return {}; } };
http.createServer((req, res) => {
  if (req.url !== "/dispatch") { res.writeHead(404); res.end(); return; }
  const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => {
    const b = JSON.parse(Buffer.concat(c).toString()); const p = b.client_payload ?? {};
    const tag = `${p.requestId}-a${p.renderAttempt ?? "x"}`; const ov = override();
    fs.appendFileSync(REG, JSON.stringify({ at: new Date().toISOString(), event_type: b.event_type, payload: p, envOverride: Object.keys(ov), script: ov.WORKER_SCRIPT || "scripts/render-worker.ts" }) + "\n");
    const env = { ...JSON.parse(fs.readFileSync(process.env.WORKER_ENV ?? path.join(LOGDIR, "worker-env.json"), "utf8")), ...ov, REQUEST_ID: p.requestId, RENDER_ATTEMPT: String(p.renderAttempt ?? "") };
    for (const [k, v] of Object.entries(env)) if (v === null) delete env[k];
    const out = fs.openSync(path.join(LOGDIR, `worker-${tag}.log`), "a");
    const script = env.WORKER_SCRIPT || "scripts/render-worker.ts";
    const ch = spawn(process.execPath, ["--import", "tsx", "--require", path.join(path.dirname(new URL(import.meta.url).pathname), "worker-preload.cjs"), script], { cwd: ROOT, env, stdio: ["ignore", out, out] });
    ch.on("exit", (code) => fs.appendFileSync(REG, JSON.stringify({ at: new Date().toISOString(), kind: "worker_exit", tag, code }) + "\n"));
    res.writeHead(202); res.end("accepted");
  });
}).listen(54400, "127.0.0.1", () => console.log("worker receiver 54400"));
