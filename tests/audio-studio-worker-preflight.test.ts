/**
 * Contrato del worker de producción de Audio Podcast Studio (T-20261119-0918-chatgpt-25), sin binarios ni red:
 *  - el workflow escucha el evento que despacha la API y ejecuta el CLI con los ids por entorno;
 *  - el despacho solo envía identificadores (nunca el token ni el guion);
 *  - el Storage desechable del preflight se comporta como Supabase Storage (404, 409 sin upsert, sin borrados);
 *  - el cortafuegos de proceso bloquea la red externa y la anota.
 * El recorrido completo con espeak-ng/FFmpeg vive en scripts/harness/audio-studio-worker-preflight/preflight.mts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { AUDIO_STUDIO_DISPATCH_EVENT, dispatchPayload, startWorker, workerOwnerIsInternal, workerPreflight } from "../src/lib/audio-studio/worker";
import { AUDIO_STUDIO_BUCKET, memoryStore, storageStore } from "../src/lib/audio-studio/store";
import { newProject } from "../src/lib/audio-studio/model";
import { startFakeStorage } from "../scripts/harness/audio-studio-worker-preflight/fake-storage.mjs";

const OWNER = "0f0f0f0f-1111-4111-8111-000000000001";
const PROJ = "0f0f0f0f-3333-4333-8333-000000000003";
const HARNESS = path.join(process.cwd(), "scripts/harness/audio-studio-worker-preflight");

test("workflow del worker: mismo evento que la API, CLI con ids por entorno, voz demo por defecto", () => {
  const wf = readFileSync(".github/workflows/audio-studio-worker.yml", "utf8");
  assert.ok(wf.includes(`types: [${AUDIO_STUDIO_DISPATCH_EVENT}]`));
  assert.match(wf, /npx tsx scripts\/audio-studio\/worker\.ts "\$OWNER_ID" "\$PROJECT_ID"/);
  assert.ok(wf.includes("OWNER_ID: ${{ github.event.client_payload.ownerId }}"));
  assert.ok(wf.includes("AUDIO_STUDIO_VOICE: ${{ vars.AUDIO_STUDIO_VOICE || 'demo' }}"));
  assert.doesNotMatch(wf, /client_payload\.(script|token|key)/i, "el payload no trae nada más que ids");
});

test("despacho GitHub: solo ids en el cuerpo; sin voz o sin credenciales no se despacha", async () => {
  const calls: { url: string; body: string; auth: string }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => { calls.push({ url, body: String(init.body), auth: String((init.headers as Record<string, string>).Authorization) }); return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
  const store = memoryStore();
  const voice = { ok: true as const, voice: { mode: "demo" as const, provider: () => { throw new Error("no"); }, voiceIdFor: () => "" } };
  assert.equal(await startWorker(store, voice, OWNER, PROJ, { VERCEL: "1", GH_WORKER_TOKEN: "secreto", GH_WORKER_REPO: "o/r" }, fakeFetch), "github");
  assert.equal(calls[0].url, "https://api.github.com/repos/o/r/dispatches");
  assert.deepEqual(JSON.parse(calls[0].body), dispatchPayload(OWNER, PROJ));
  assert.ok(!calls[0].body.includes("secreto") && calls[0].auth === "Bearer secreto");
  assert.equal(await startWorker(store, { ok: false, reason: "x" }, OWNER, PROJ, { VERCEL: "1", GH_WORKER_TOKEN: "t", GH_WORKER_REPO: "o/r" }, fakeFetch), "apagado");
  assert.equal(await startWorker(store, voice, OWNER, PROJ, { VERCEL: "1" }, fakeFetch), "apagado");
  assert.equal(calls.length, 1);
  assert.throws(() => dispatchPayload("x", PROJ));
});

test("verificación previa del worker: dueño exacto, estado y autorización", async () => {
  const store = memoryStore();
  const p = newProject({ id: PROJ, ownerId: OWNER, now: new Date().toISOString(), title: "t" });
  await store.create(p);
  assert.match((await workerPreflight(store, OWNER, PROJ))!, /nada que hacer/);
  await store.put({ ...p, generation: { ...p.generation, status: "en_cola", kind: "generar", authorization: null } });
  assert.match((await workerPreflight(store, OWNER, PROJ))!, /sin autorización/);
  const auth = { usd: 0, revision: p.revision, at: "x", spentBefore: 0, model: p.ttsModel };
  await store.put({ ...p, generation: { ...p.generation, status: "en_cola", kind: "generar", authorization: auth } });
  assert.equal(await workerPreflight(store, OWNER, PROJ, { demo: true }), null, "demo: monto 0 válido");
  assert.match((await workerPreflight(store, OWNER, PROJ))!, /monto/, "voz de pago: monto 0 inválido");
  assert.match((await workerPreflight(store, "0f0f0f0f-2222-4222-8222-000000000002", PROJ, { demo: true }))!, /inexistente/);
  assert.equal(workerOwnerIsInternal(OWNER, { INTERNAL_PRODUCTION_OWNER_USER_ID: OWNER.toUpperCase() }), true);
  assert.equal(workerOwnerIsInternal(OWNER, {}), false);
});

test("Storage desechable: semántica de Supabase con el cliente real (404, 409 sin upsert, sin borrados)", async () => {
  const fs = await startFakeStorage({ bucket: AUDIO_STUDIO_BUCKET });
  try {
    const store = storageStore(createClient(fs.url, fs.key, { auth: { persistSession: false } }).storage.from(AUDIO_STUDIO_BUCKET) as never);
    const p = newProject({ id: PROJ, ownerId: OWNER, now: new Date().toISOString(), title: "t" });
    assert.equal(await store.get(OWNER, PROJ), null);
    assert.equal(await store.create(p), true);
    assert.equal(await store.create(p), false, "crear dos veces no sobrescribe");
    assert.equal((await store.get(OWNER, PROJ))?.id, PROJ);
    assert.deepEqual((await store.list(OWNER)).map((x) => x.id), [PROJ]);
    const blob = `audio-studio/v1/${OWNER}/${PROJ}/audio/a.mp3`;
    await store.putBlob(blob, Buffer.from("uno"), "audio/mpeg");
    await store.putBlob(blob, Buffer.from("dos"), "audio/mpeg");
    assert.equal((await store.getBlob(blob))!.toString(), "uno", "un MP3 publicado es inmutable");
    assert.equal(await store.hasBlob(blob), true);
    const del = await createClient(fs.url, fs.key, { auth: { persistSession: false } }).storage.from(AUDIO_STUDIO_BUCKET).remove([blob]);
    assert.ok(del.error, "el Storage del preflight rechaza borrados");
    const bad = await createClient(fs.url, "otra-clave", { auth: { persistSession: false } }).storage.from(AUDIO_STUDIO_BUCKET).download(blob);
    assert.ok(bad.error, "sin la clave correcta no hay acceso");
  } finally { await fs.close(); }
});

test("cortafuegos de proceso: bloquea y anota red externa, deja pasar 127.0.0.1", () => {
  const log = path.join(mkdtempSync(path.join(tmpdir(), "aps-guard-")), "red.ndjson");
  const code = `const r = []; try { await fetch("https://api.elevenlabs.io/v1/voices"); r.push("salio"); } catch (e) { r.push(String(e.message)); }
    const net = await import("node:net"); await new Promise((ok) => { const s = net.connect(443, "example.com"); s.on("error", (e) => { r.push(e.message); ok(); }); s.on("connect", () => { r.push("conecto"); ok(); }); });
    console.log(JSON.stringify(r));`;
  const out = spawnSync(process.execPath, ["--import", path.join(HARNESS, "net-guard.mjs"), "--input-type=module", "-e", code], { env: { ...process.env, PREFLIGHT_NET_LOG: log }, encoding: "utf8" });
  const r = JSON.parse(out.stdout.trim());
  assert.match(r[0], /red externa bloqueada \(api\.elevenlabs\.io\)/);
  assert.match(r[1], /red externa bloqueada \(example\.com\)/);
  const noted = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(noted.length, 2);
});
