import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isUploadPathFor, newUploadPath, sniffImage, validateUpload, UPLOAD_MAX_BYTES } from "./curation-upload";

const RID = "5bc99f47-7759-48c7-a2a2-92a282d97f78";

function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(13, 8); b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}
function jpeg(w: number, h: number): Buffer {
  // SOI, APP0 (16 bytes), SOF0 with height/width
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(16)]);
}

test("tipo real por bytes y dimensiones de la cabecera (PNG, JPEG, WebP); el MIME declarado no cuenta", () => {
  assert.deepEqual(sniffImage(png(1920, 1080)), { mime: "image/png", width: 1920, height: 1080 });
  assert.deepEqual(sniffImage(jpeg(1600, 1200)), { mime: "image/jpeg", width: 1600, height: 1200 });
  const vp8x = Buffer.alloc(30); vp8x.write("RIFF", 0, "ascii"); vp8x.write("WEBP", 8, "ascii"); vp8x.write("VP8X", 12, "ascii"); vp8x.writeUIntLE(2047, 24, 3); vp8x.writeUIntLE(1151, 27, 3);
  assert.deepEqual(sniffImage(vp8x), { mime: "image/webp", width: 2048, height: 1152 });
  assert.match((sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")) as { error: string }).error, /no es una imagen/);
  assert.match((sniffImage(Buffer.from("%PDF-1.7 ...")) as { error: string }).error, /no es una imagen/);
});

test("validación: ≥ 1280 px de lado largo sin reescalar, tamaño máximo, SHA-256 del contenido exacto", () => {
  assert.match((validateUpload(png(1279, 900)) as { error: string }).error, /1279 px < 1280 px/);
  const ok = validateUpload(png(900, 1280));
  assert.ok(!("error" in ok) && ok.sha256.length === 64 && ok.bytes === 33);
  assert.notEqual((validateUpload(png(1281, 900)) as { sha256: string }).sha256, (ok as { sha256: string }).sha256);
  assert.match((validateUpload(Buffer.alloc(0)) as { error: string }).error, /vacío/);
  const big = Buffer.concat([png(2000, 2000), Buffer.alloc(UPLOAD_MAX_BYTES)]);
  assert.match((validateUpload(big) as { error: string }).error, /supera 25 MB/);
});

test("ruta: solo las rutas que el servidor emitió para ESTA solicitud", () => {
  const p = newUploadPath(RID, "image/png");
  assert.ok(isUploadPathFor(RID, p));
  assert.ok(!isUploadPathFor("00000000-0000-0000-0000-000000000000", p));
  assert.ok(!isUploadPathFor(RID, `${RID}/state/curation.json`));
  assert.ok(!isUploadPathFor(RID, `${RID}/curation/uploads/../state/x.png`));
  assert.ok(!isUploadPathFor(RID, p.replace(".png", ".svg")));
});

test("archivo real generado con ffmpeg (si está disponible)", { skip: !hasFfmpeg() }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "upl-"));
  for (const [ext, mime] of [["jpg", "image/jpeg"], ["png", "image/png"], ["webp", "image/webp"]] as const) {
    const f = path.join(dir, `x.${ext}`);
    try { execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=1600x900:rate=1", "-frames:v", "1", "-y", f]); } catch { continue; }
    const r = validateUpload(readFileSync(f));
    assert.ok(!("error" in r), `${ext}: ${JSON.stringify(r)}`);
    assert.deepEqual([r.mime, r.width, r.height], [mime, 1600, 900]);
  }
});
function hasFfmpeg() { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } }

test("la subida solo PROPONE: nunca escribe decisiones ni aprueba; el curador sale de la sesión", () => {
  const src = readFileSync(path.join(__dirname, "../../../app/dashboard/admin/curation/[requestId]/actions.ts"), "utf8");
  const fin = src.slice(src.indexOf("export async function finalizeUploadAction"));
  assert.match(fin, /^export async function finalizeUploadAction[^]*?await curator\(\);/);
  assert.match(fin, /proposeAsset\(/);
  assert.doesNotMatch(fin, /decideLink|APPROVED|decisions/);
  assert.match(fin, /isUploadPathFor\(requestId, path\)/);
  assert.match(fin, /validateUpload\(/);
  const ticket = src.slice(src.indexOf("export async function createUploadTicketAction"), src.indexOf("export async function finalizeUploadAction"));
  assert.match(ticket, /await curator\(\);/);
});
