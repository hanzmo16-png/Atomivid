import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyStorageError,
  decideOutputFit,
  estimateOutputBytes,
  LONG_FORM_ENCODING_PROFILE,
  LONG_FORM_OUTPUT_POLICY,
  LongFormOutputError,
  OUTPUT_NOT_SAVED_CUSTOMER_MESSAGE,
  configuredStorageMaxBytes,
} from "./output-policy";
import { canonicalOutputPath, finalizeLongFormOutput, memoryOutputDeps, reconcileExistingOutput } from "./output-finalize";
import { OutputUploadError, uploadOutputFile, TUS_CHUNK_BYTES } from "./output-upload";
import { scrubInternalPaths } from "../run-job";

/**
 * P0 2026-09-25 (Canal de Panamá): final.mp4 de ~300 s rechazado por
 * Storage con "The object exceeded the maximum allowed size". Todo aquí es
 * en memoria/archivos temporales: sin red, sin proveedores, sin costo.
 */

const MiB = 1024 * 1024;
const REQ = "2f35d750-8023-456d-810e-d805cba7859c";

function tmpFile(bytes: number, name = "final"): string {
  const p = path.join(os.tmpdir(), `lf-out-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
  fs.writeFileSync(p, Buffer.alloc(bytes));
  return p;
}

test("política: un archivo bajo el techo se sube tal cual", () => {
  assert.deepEqual(decideOutputFit({ bytes: 40 * MiB, durationSeconds: 300, ceilingBytes: 50 * MiB }), { action: "upload" });
});

test("política: el caso Panamá (300 s, > 50 MiB) se ajusta desde el mismo archivo a un bitrate entregable", () => {
  const d = decideOutputFit({ bytes: 150 * MiB, durationSeconds: 300.3, ceilingBytes: 50 * MiB });
  assert.equal(d.action, "fit");
  if (d.action !== "fit") return;
  assert.ok(d.targetVideoKbps >= LONG_FORM_OUTPUT_POLICY.minFitVideoKbps);
  const predicted = ((d.targetVideoKbps + d.audioKbps) * 1000 * 300.3) / 8;
  assert.ok(predicted <= 50 * MiB, `predicho ${predicted} > techo`);
});

test("política: 15 min contra el límite de 50 MiB NO se degrada por debajo del piso de calidad — se diagnostica", () => {
  const d = decideOutputFit({ bytes: 400 * MiB, durationSeconds: 900, ceilingBytes: 50 * MiB });
  assert.equal(d.action, "too_large");
});

test("política: un documental de 15 min en el PEOR caso del perfil v1 cabe en el techo de la política con margen ≥ 1.5×", () => {
  const worst = estimateOutputBytes(900).worstCaseBytes;
  assert.ok(worst * 1.5 <= LONG_FORM_OUTPUT_POLICY.policyMaxBytes, `peor caso ${worst}`);
  assert.equal(decideOutputFit({ bytes: worst, durationSeconds: 900, ceilingBytes: LONG_FORM_OUTPUT_POLICY.policyMaxBytes }).action, "upload");
  // Envolvente documentada: 3/5/10/15 min, monotónica.
  const sizes = [180, 300, 600, 900].map((s) => estimateOutputBytes(s).worstCaseBytes);
  assert.deepEqual([...sizes].sort((a, b) => a - b), sizes);
  assert.equal(LONG_FORM_ENCODING_PROFILE.width, 1920);
});

test("clasificación: el mensaje EXACTO de producción es rechazo por tamaño (no se reintenta)", () => {
  assert.equal(classifyStorageError({ message: "The object exceeded the maximum allowed size" }), "size_rejected");
  assert.equal(classifyStorageError({ status: 413, message: "" }), "size_rejected");
  assert.equal(classifyStorageError({ status: 503, message: "Service Unavailable" }), "transient");
  assert.equal(classifyStorageError({ status: null, message: "TypeError: fetch failed (ECONNRESET)" }), "transient");
  assert.equal(classifyStorageError({ status: 401, message: "invalid JWT" }), "auth");
});

test("techo configurado: LONG_FORM_STORAGE_MAX_OBJECT_BYTES vacío/ inválido → null", () => {
  assert.equal(configuredStorageMaxBytes({}), null);
  assert.equal(configuredStorageMaxBytes({ LONG_FORM_STORAGE_MAX_OBJECT_BYTES: "abc" }), null);
  assert.equal(configuredStorageMaxBytes({ LONG_FORM_STORAGE_MAX_OBJECT_BYTES: "1073741824" }), 1073741824);
});

test("entrega: final.mp4 mayor que el límite viejo → Storage rechaza → se ajusta desde el MISMO archivo y se sube a la ruta canónica", async () => {
  const out = memoryOutputDeps({ durationSeconds: 300, storageLimitBytes: 50 * MiB });
  const file = tmpFile(60 * MiB);
  const { videoPath, state } = await finalizeLongFormOutput({ requestId: REQ, attempt: 1, filePath: file }, out.deps);
  assert.equal(videoPath, canonicalOutputPath(REQ));
  assert.equal(videoPath, `${REQ}/output/final.mp4`);
  assert.equal(state.status, "UPLOADED");
  assert.equal(state.delivery, "size_fit");
  assert.equal(state.rendered?.bytes, 60 * MiB);
  assert.ok((state.delivered?.bytes ?? Infinity) <= 50 * MiB);
  assert.equal(out.calls.transcode, 1, "un solo ajuste, sin re-render");
  assert.equal(out.calls.upload, 2, "1 rechazo por tamaño + 1 subida del archivo ajustado");
  assert.ok(state.uploadAttempts?.some((a) => a.category === "size_rejected"));
  assert.equal(out.states.get(REQ)?.status, "UPLOADED");
  fs.rmSync(file, { force: true });
});

test("entrega: con techo configurado el ajuste ocurre ANTES de subir (preflight, sin subida condenada)", async () => {
  const out = memoryOutputDeps({ durationSeconds: 300, storageLimitBytes: 50 * MiB });
  out.deps.storageMaxBytes = 50 * MiB;
  const file = tmpFile(60 * MiB);
  const { state } = await finalizeLongFormOutput({ requestId: REQ, attempt: 1, filePath: file }, out.deps);
  assert.equal(out.calls.upload, 1);
  assert.equal(state.delivery, "size_fit");
  fs.rmSync(file, { force: true });
});

test("entrega: bajo el techo se sube tal cual (sin transcodificar)", async () => {
  const out = memoryOutputDeps({ durationSeconds: 180 });
  const file = tmpFile(2 * MiB);
  const { state } = await finalizeLongFormOutput({ requestId: REQ, attempt: 1, filePath: file }, out.deps);
  assert.equal(state.delivery, "as_rendered");
  assert.equal(out.calls.transcode, 0);
  fs.rmSync(file, { force: true });
});

test("entrega: Storage 5xx persistente → error SEGURO para el cliente, detalle de admin en el estado, archivo conservado", async () => {
  const keepDir = fs.mkdtempSync(path.join(os.tmpdir(), "lf-keep-"));
  const out = memoryOutputDeps({ durationSeconds: 180, transientUploadFailures: 1 });
  out.deps.keepDir = keepDir;
  const file = tmpFile(1 * MiB);
  await assert.rejects(
    () => finalizeLongFormOutput({ requestId: REQ, attempt: 1, filePath: file }, out.deps),
    (err: unknown) => {
      assert.ok(err instanceof LongFormOutputError);
      assert.equal(err.category, "transient");
      assert.equal(err.customerMessage, OUTPUT_NOT_SAVED_CUSTOMER_MESSAGE);
      assert.ok(!err.customerMessage.includes(REQ) && !/final\.mp4|attempt-/.test(err.customerMessage));
      assert.match(err.diagnosticId, /^[0-9a-f]{8}$/);
      assert.equal(err.adminDetail.stage, "upload");
      assert.equal(err.adminDetail.bytes, 1 * MiB);
      return true;
    },
  );
  const state = out.states.get(REQ);
  assert.equal(state?.status, "FAILED");
  assert.equal(state?.failure?.category, "transient");
  assert.ok(state?.keptLocalCopy && fs.existsSync(state.keptLocalCopy), "el MP4 renderizado queda para recuperarlo");
  assert.equal(out.objects.size, 0);
  fs.rmSync(keepDir, { recursive: true, force: true });
  fs.rmSync(file, { force: true });
});

test("entrega: demasiado grande incluso ajustando (15 min vs 50 MiB) → too_large, sin subir nada degradado", async () => {
  const out = memoryOutputDeps({ durationSeconds: 900, storageLimitBytes: 50 * MiB });
  const file = tmpFile(60 * MiB);
  await assert.rejects(() => finalizeLongFormOutput({ requestId: REQ, attempt: 1, filePath: file }, out.deps), (err: unknown) => err instanceof LongFormOutputError && err.category === "too_large");
  assert.equal(out.calls.transcode, 0);
  fs.rmSync(file, { force: true });
});

test("reconciliación: subida OK + fallo al escribir estado/actualizar la fila → el reintento reutiliza el objeto canónico", async () => {
  const out = memoryOutputDeps({ durationSeconds: 180, failWriteState: true });
  const file = tmpFile(1 * MiB);
  await finalizeLongFormOutput({ requestId: REQ, attempt: 1, filePath: file }, out.deps);
  assert.equal(out.states.size, 0, "el estado no se pudo escribir");
  const again = await reconcileExistingOutput(REQ, out.deps);
  assert.equal(again?.videoPath, canonicalOutputPath(REQ));
  assert.equal(await reconcileExistingOutput("otra-solicitud", out.deps), null);
  fs.rmSync(file, { force: true });
});

test("reconciliación: un estado UPLOADED cuyo tamaño no coincide con el objeto NO se da por bueno", async () => {
  const out = memoryOutputDeps({ durationSeconds: 180 });
  const file = tmpFile(1 * MiB);
  await finalizeLongFormOutput({ requestId: REQ, attempt: 1, filePath: file }, out.deps);
  out.objects.set(canonicalOutputPath(REQ), 123);
  assert.equal(await reconcileExistingOutput(REQ, out.deps), null);
  fs.rmSync(file, { force: true });
});

test("el cliente nunca ve la ruta cruda: el error_message histórico de Panamá queda sin rutas internas", () => {
  const raw = `No se pudo subir ${REQ}/attempt-1/final.mp4: The object exceeded the maximum allowed size`;
  const scrubbed = scrubInternalPaths(raw);
  assert.ok(!scrubbed.includes(REQ));
  assert.ok(!scrubbed.includes("attempt-1/final.mp4"));
  assert.ok(!scrubInternalPaths(`long-form/${REQ}/tts/abc.mp3`).includes(REQ));
});

// --- Subida reanudable (TUS) con fetch simulado ---

function fakeTusServer(opts: { dropAfterChunks?: number; rejectCreateStatus?: number; endpoint404?: boolean } = {}) {
  let received = 0;
  let chunks = 0;
  let dropped = false;
  const log: string[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    log.push(method);
    const headers = new Headers(init?.headers);
    if (method === "POST") {
      if (opts.endpoint404) return new Response("not found", { status: 404 });
      if (opts.rejectCreateStatus) return new Response('{"message":"The object exceeded the maximum allowed size"}', { status: opts.rejectCreateStatus });
      assert.equal(headers.get("x-upsert"), "true");
      assert.ok(headers.get("upload-metadata")?.includes("bucketName"));
      return new Response(null, { status: 201, headers: { location: "https://x.supabase.co/storage/v1/upload/resumable/abc" } });
    }
    if (method === "HEAD") return new Response(null, { status: 200, headers: { "upload-offset": String(received) } });
    if (method === "PATCH") {
      assert.equal(Number(headers.get("upload-offset")), received, "cada trozo se envía desde el offset confirmado");
      if (opts.dropAfterChunks !== undefined && chunks === opts.dropAfterChunks && !dropped) {
        dropped = true;
        throw new TypeError("fetch failed (ECONNRESET)");
      }
      const body = init?.body as Uint8Array;
      received += body.byteLength;
      chunks += 1;
      return new Response(null, { status: 204, headers: { "upload-offset": String(received) } });
    }
    return new Response(null, { status: 405 });
  }) as typeof fetch;
  return { f, log, received: () => received };
}

test("subida reanudable: trozos de 6 MB, conexión cortada a mitad → reanuda desde el offset confirmado (no desde cero)", async () => {
  const file = tmpFile(TUS_CHUNK_BYTES * 2 + 1234, "tus");
  const server = fakeTusServer({ dropAfterChunks: 1 });
  let standard = 0;
  const res = await uploadOutputFile(
    { bucket: "videos", objectPath: `${REQ}/output/final.mp4`, filePath: file, contentType: "video/mp4" },
    { supabaseUrl: "https://x.supabase.co", serviceKey: "k", fetch: server.f, sleep: async () => {}, standardUpload: async () => ((standard += 1), { error: null }) },
  );
  assert.equal(res.method, "resumable");
  assert.equal(server.received(), TUS_CHUNK_BYTES * 2 + 1234, "cada byte se envió exactamente una vez");
  assert.equal(server.log.filter((m) => m === "POST").length, 1, "misma sesión de subida");
  assert.ok(server.log.includes("HEAD"), "consultó el offset al reanudar");
  assert.equal(standard, 0);
  fs.rmSync(file, { force: true });
});

test("subida reanudable: rechazo por tamaño al crear → OutputUploadError size_rejected, sin reintentos", async () => {
  const file = tmpFile(1024, "tus413");
  const server = fakeTusServer({ rejectCreateStatus: 413 });
  await assert.rejects(
    () =>
      uploadOutputFile(
        { bucket: "videos", objectPath: "x/output/final.mp4", filePath: file, contentType: "video/mp4" },
        { supabaseUrl: "https://x.supabase.co", serviceKey: "k", fetch: server.f, sleep: async () => {}, standardUpload: async () => ({ error: null }) },
      ),
    (err: unknown) => err instanceof OutputUploadError && err.category === "size_rejected",
  );
  assert.equal(server.log.filter((m) => m === "POST").length, 1);
  fs.rmSync(file, { force: true });
});

test("subida: sin endpoint reanudable → respaldo estándar del MISMO archivo con reintentos acotados en 5xx", async () => {
  const file = tmpFile(2048, "std");
  const server = fakeTusServer({ endpoint404: true });
  let calls = 0;
  const res = await uploadOutputFile(
    { bucket: "videos", objectPath: "x/output/final.mp4", filePath: file, contentType: "video/mp4" },
    {
      supabaseUrl: "https://x.supabase.co",
      serviceKey: "k",
      fetch: server.f,
      sleep: async () => {},
      standardUpload: async (_p, buffer) => {
        calls += 1;
        assert.equal(buffer.byteLength, 2048);
        return calls < 3 ? { error: { message: "Bad Gateway", status: 502 } } : { error: null };
      },
    },
  );
  assert.equal(res.method, "standard");
  assert.equal(calls, 3);
  fs.rmSync(file, { force: true });
});
