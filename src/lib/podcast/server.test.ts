import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isRecordingPathFor, masterRecording, recordingUploadPath, sniffAudio } from "./recording";
import { isStalledRun, PODCAST_STALE_RUN_MS } from "./episode";

const src = (p: string) => readFileSync(path.join(__dirname, p), "utf8");

test("generación: una sola ejecución (CAS), capacidad comprobada antes de pagar, y cada parte por el registro de pagos", () => {
  const s = src("server.ts");
  const run = s.slice(s.indexOf("export async function runGeneration"));
  const claim = run.indexOf('.in("status", ["draft", "failed"])'), ready = run.indexOf("ensureJobSupplyReady("), narrate = run.indexOf("narrateEpisode(");
  assert.ok(claim > 0 && claim < ready && ready < narrate, "claim → admission (refresh: true) → narration");
  assert.match(run, /claim\.eq\("status", "generating"\)\.lt\("run_started_at", stale\)/, "only a dead run is resumed");
  assert.match(run, /claimed\.length !== 1/);
  assert.match(run, /\.eq\("run_token", token\)/, "final write fenced by the run token");
  assert.match(src("narrate.ts"), /gatedVoiceSynthesize\(/);
  const create = s.slice(s.indexOf("export async function createEpisode"), s.indexOf("const PUBLIC_REASON"));
  assert.match(create, /listAccountVoices\(\)/, "the chosen voice is re-checked against the account on the server");
  assert.doesNotMatch(create, /synthesize|gatedVoice/, "creating a draft never generates");
});

test("rutas: autenticación y propiedad en cada una; la de capacidad solo consulta saldos", () => {
  const dir = path.join(__dirname, "../../app/api/podcast");
  for (const r of ["route.ts", "voices/route.ts", "[id]/generate/route.ts", "[id]/refresh-capacity/route.ts", "[id]/recording/route.ts"]) {
    const s = readFileSync(path.join(dir, r), "utf8");
    assert.match(s, /await podcastUser\(\)/, r);
    if (r.startsWith("[id]")) assert.match(s, /loadOwnedEpisode\(service, user\.id, id\)/, r);
  }
  const cap = readFileSync(path.join(dir, "[id]/refresh-capacity/route.ts"), "utf8");
  assert.doesNotMatch(cap, /runGeneration|synthesize|\.update\(/);
});

test("ejecución interrumpida: se puede continuar tras el plazo; antes no", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  assert.equal(isStalledRun({ status: "generating", run_started_at: new Date(now - PODCAST_STALE_RUN_MS - 1).toISOString() }, now), true);
  assert.equal(isStalledRun({ status: "generating", run_started_at: new Date(now - 60_000).toISOString() }, now), false);
  assert.equal(isStalledRun({ status: "ready", run_started_at: null }, now), false);
});

test("grabación propia: tipo real por bytes, rutas emitidas por el servidor, rechazos claros", async () => {
  assert.equal(sniffAudio(Buffer.concat([Buffer.from("ID3"), Buffer.alloc(20)])), "mp3");
  assert.equal(sniffAudio(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypM4A "), Buffer.alloc(8)])), "m4a");
  const wav = Buffer.alloc(16); wav.write("RIFF", 0, "ascii"); wav.write("WAVE", 8, "ascii");
  assert.equal(sniffAudio(wav), "wav");
  assert.equal(sniffAudio(Buffer.from("%PDF-1.7 not audio")), null);
  const u = "6b4b3c1e-0000-4000-8000-000000000001", e = "6b4b3c1e-0000-4000-8000-000000000002";
  const p = recordingUploadPath(u, e);
  assert.ok(isRecordingPathFor(u, e, p));
  assert.ok(!isRecordingPathFor(u, "6b4b3c1e-0000-4000-8000-000000000003", p));
  assert.ok(!isRecordingPathFor(u, e, `${u}/podcasts/${e}/episode.m4a`));
  assert.deepEqual(await masterRecording(Buffer.from("%PDF-1.7 not audio at all"), async () => 1), { error: "no es un audio MP3, M4A, WAV, WebM u Ogg" });
  assert.deepEqual(await masterRecording(wav, async () => { throw new Error("video stream"); }), { error: "el audio no se pudo leer completo (o contiene video)" });
  assert.deepEqual(await masterRecording(wav, async () => 3 * 3600), { error: "la grabación supera 2 horas" });
});
