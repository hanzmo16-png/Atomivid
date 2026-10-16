import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { BANNER, assertLocalOnly, childEnv, commandFor, createUiServer, type Runner } from "./ui-server";

const repo = path.resolve(__dirname, "../..");

/** Runner falso: escribe un report.json mínimo (o nada) y termina cuando el test lo decide. */
function fakeRunner(outcome: { exit: number; report?: (outDir: string) => object }) {
  const calls: { cmd: string; args: string[]; env: Record<string, string | undefined> }[] = [];
  const pending: (() => void)[] = [];
  const runner: Runner = (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts.env });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    const outDir = args.find((a) => a.startsWith("--out-dir="))?.slice(10);
    pending.push(() => {
      if (outDir && outcome.report) fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(outcome.report(outDir)));
      child.stdout.end("salida simulada\n");
      child.emit("exit", outcome.exit);
    });
    return child as never;
  };
  return { runner, calls, finish: () => pending.shift()?.() };
}

function okReport(outDir: string) {
  const mp4 = path.join(outDir, "reel", "x.mp4");
  fs.mkdirSync(path.dirname(mp4), { recursive: true });
  fs.writeFileSync(mp4, "fake-mp4-bytes");
  const sha = require("node:crypto").createHash("sha256").update("fake-mp4-bytes").digest("hex");
  return {
    summary: { PASS: 2, FAIL: 0, NOT_VERIFIED: 0 },
    zero_paid_controls: { actual_provider_spend_usd: 0, blockedExternalAttempts: [] },
    scenarios: [
      { id: "RE-01", status: "PASS", title: "reel", reason: "ok", artifacts: [{ path: mp4, sha256: sha, bytes: 14, ffprobe: { durationSeconds: 1, video: { codec: "h264", width: 1080, height: 1920 } } }] },
      { id: "QA-02", status: "PASS", title: "control", reason: "ok" },
    ],
  };
}

function req(port: number, method: string, p: string, body?: object, host = `127.0.0.1:${port}`): Promise<{ status: number; text: string; json?: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: { host, ...(data ? { "content-type": "application/json" } : {}) } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => { let json; try { json = JSON.parse(text); } catch { /* html o binario */ } resolve({ status: res.statusCode!, text, json }); });
    });
    r.on("error", reject);
    r.end(data);
  });
}

async function withServer(runner: Runner, fn: (port: number, root: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sim-ui-test-"));
  const ui = createUiServer({ repo, root, runner, env: { PATH: process.env.PATH } });
  const port = await ui.listen(0);
  try { await fn(port, root); } finally { await ui.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

const waitFor = async (cond: () => Promise<boolean>) => { for (let i = 0; i < 50; i++) { if (await cond()) return; await new Promise((r) => setTimeout(r, 20)); } throw new Error("timeout"); };

test("la página y todo JSON llevan la marca de simulación", async () => {
  const f = fakeRunner({ exit: 0, report: okReport });
  await withServer(f.runner, async (port) => {
    const home = await req(port, "GET", "/");
    assert.equal(home.status, 200);
    assert.ok(home.text.includes(BANNER));
    const list = await req(port, "GET", "/api/jobs");
    assert.equal(list.json?.banner, BANNER);
    assert.equal(list.json?.simulation, true);
  });
});

test("Reel: inicio → en curso → terminado con MP4 servido, SHA y control USD 0", async () => {
  const f = fakeRunner({ exit: 0, report: okReport });
  await withServer(f.runner, async (port) => {
    const r = await req(port, "POST", "/api/jobs", { mode: "reel" });
    assert.equal(r.status, 202);
    const id = (r.json?.job as { id: string }).id;
    assert.equal((r.json?.job as { status: string }).status, "running");
    assert.ok(f.calls[0].args.includes("--mode=reel"));
    f.finish();
    await waitFor(async () => ((await req(port, "GET", `/api/jobs/${id}`)).json?.job as { status: string }).status !== "running");
    const job = (await req(port, "GET", `/api/jobs/${id}`)).json?.job as { status: string; artifacts: { file: string }[]; zeroPaidControl: { actualProviderSpendUsd: number; qa02: string }; outDir?: string };
    assert.equal(job.status, "passed");
    assert.equal(job.zeroPaidControl.actualProviderSpendUsd, 0);
    assert.equal(job.zeroPaidControl.qa02, "PASS");
    assert.equal(job.outDir, undefined, "no expone rutas locales");
    const mp4 = await req(port, "GET", `/files/${id}/${job.artifacts[0].file}`);
    assert.equal(mp4.status, 200);
    assert.equal(mp4.text, "fake-mp4-bytes");
  });
});

test("doble clic: una segunda corrida mientras hay otra en curso se rechaza (409) y no lanza proceso", async () => {
  const f = fakeRunner({ exit: 0, report: okReport });
  await withServer(f.runner, async (port) => {
    assert.equal((await req(port, "POST", "/api/jobs", { mode: "avatar" })).status, 202);
    const second = await req(port, "POST", "/api/jobs", { mode: "reel" });
    assert.equal(second.status, 409);
    assert.match(String(second.json?.error), /en curso/);
    assert.equal(f.calls.length, 1);
    f.finish();
  });
});

test("fallo sin report.json: estado failed con error comprensible y reintento posible", async () => {
  const f = fakeRunner({ exit: 2 });
  await withServer(f.runner, async (port) => {
    const id = ((await req(port, "POST", "/api/jobs", { mode: "reel" })).json?.job as { id: string }).id;
    f.finish();
    await waitFor(async () => ((await req(port, "GET", `/api/jobs/${id}`)).json?.job as { status: string }).status === "failed");
    const job = (await req(port, "GET", `/api/jobs/${id}`)).json?.job as { error: string };
    assert.match(job.error, /sin report\.json/);
    assert.equal((await req(port, "POST", "/api/jobs", { mode: "reel" })).status, 202, "tras el fallo se puede reintentar");
    f.finish();
  });
});

test("QA-02 en FAIL (algo tocó la red) marca la corrida como fallida aunque el resto pase", async () => {
  const f = fakeRunner({ exit: 0, report: (d) => ({ ...okReport(d), scenarios: [{ id: "QA-02", status: "FAIL", title: "control", reason: "1 intento externo" }] }) });
  await withServer(f.runner, async (port) => {
    const id = ((await req(port, "POST", "/api/jobs", { mode: "avatar" })).json?.job as { id: string }).id;
    f.finish();
    await waitFor(async () => ((await req(port, "GET", `/api/jobs/${id}`)).json?.job as { status: string }).status !== "running");
    const job = (await req(port, "GET", `/api/jobs/${id}`)).json?.job as { status: string; error: string };
    assert.equal(job.status, "failed");
    assert.match(job.error, /QA-02/);
  });
});

test("600 s exige confirmación explícita; modos desconocidos se rechazan", async () => {
  const f = fakeRunner({ exit: 0 });
  await withServer(f.runner, async (port) => {
    assert.equal((await req(port, "POST", "/api/jobs", { mode: "longform-600" })).status, 400);
    assert.equal((await req(port, "POST", "/api/jobs", { mode: "render-real" })).status, 400);
    assert.equal(f.calls.length, 0);
  });
});

test("Host distinto (DNS rebinding) → 403; rutas fuera del directorio de la corrida → 404", async () => {
  const f = fakeRunner({ exit: 0, report: okReport });
  await withServer(f.runner, async (port) => {
    assert.equal((await req(port, "GET", "/api/jobs", undefined, "evil.example:80")).status, 403);
    const id = ((await req(port, "POST", "/api/jobs", { mode: "reel" })).json?.job as { id: string }).id;
    f.finish();
    for (const p of [`/files/${id}/..%2F..%2Fjobs.json`, `/files/${id}/%2Fetc%2Fpasswd`, `/files/${id}/../../../../etc/passwd`, `/files/nope/x.mp4`]) {
      assert.equal((await req(port, "GET", p)).status, 404, p);
    }
  });
});

test("los procesos hijos arrancan sin claves de proveedores ni variables de producción", () => {
  const env = childEnv({ PATH: "/bin", HOME: "/h", OPENAI_API_KEY: "x", ELEVENLABS_API_KEY: "x", SUPABASE_SERVICE_ROLE_KEY: "x", GH_WORKER_TOKEN: "x", STRIPE_SECRET_KEY: "x", NODE_ENV: "production" });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "NODE_ENV", "PATH"]);
  assert.equal(env.NODE_ENV, "development");
});

test("se niega a arrancar en entornos de despliegue o producción", () => {
  for (const env of [{ VERCEL: "1" }, { VERCEL_ENV: "production" }, { NODE_ENV: "production" }, { ATOMIVID_RUNTIME: "production" }, { GITHUB_ACTIONS: "true" }]) {
    assert.throws(() => assertLocalOnly(env), /negado/);
  }
  assert.doesNotThrow(() => assertLocalOnly({ PATH: "/bin" }));
});

test("los comandos son la CLI auditada o las pruebas de Long Form; nunca rutas de producción", () => {
  const out = "/tmp/x";
  assert.deepEqual(commandFor("reel", out, repo).args.slice(-2), ["--mode=reel", `--out-dir=${out}`]);
  assert.deepEqual(commandFor("avatar", out, repo).args.slice(-2), ["--mode=avatar", `--out-dir=${out}`]);
  assert.deepEqual(commandFor("longform-600", out, repo).args.slice(-2), ["--mode=youtube", `--out-dir=${out}`]);
  const lf = commandFor("longform", out, repo).args;
  assert.ok(lf.includes("--test") && lf.filter((a) => a.endsWith(".test.ts")).length > 10);
  assert.ok(lf.every((a) => !a.includes("youtube")), "Long Form por defecto no lanza el render de 600 s");
});

test("el servidor no importa Supabase, workers, rutas de la app ni proveedores", () => {
  const src = fs.readFileSync(path.join(__dirname, "ui-server.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const imports = [...src.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(imports.filter((i) => !i.startsWith("node:")), [], "solo módulos de Node");
  assert.doesNotMatch(src, /src\/lib\/(supabase|worker|providers)|api\/generate|createServiceClient|repository_dispatch/);
});
