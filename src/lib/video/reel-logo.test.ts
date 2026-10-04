import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadReelLogo, MAX_REEL_LOGO_BYTES, normalizeReelLogo, REEL_LOGO_BUCKET, reelLogoPath } from "./reel-logo";

const owner = "d2064950-7a95-4208-8dfb-d93b470d141d";
const request = "4638ee8e-acd8-491a-9b4f-bd8a42ebbed0";
const png = () => sharp({ create: { width: 64, height: 32, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();

test("small genuine logos are accepted, transparency and aspect ratio survive normalization", async () => {
  const data = await png();
  assert.ok(data.length < 4096);
  const result = await normalizeReelLogo(data, "image/png");
  const meta = await sharp(result).metadata();
  assert.equal(meta.width, 64); assert.equal(meta.height, 32); assert.equal(meta.hasAlpha, true);
  const raw = await sharp(result).raw().toBuffer();
  assert.ok(raw[3] > 0 && raw[3] < 255);
});

test("valid large logos are resized without distortion", async () => {
  const data = await sharp({ create: { width: 1600, height: 800, channels: 4, background: "red" } }).png().toBuffer();
  const meta = await sharp(await normalizeReelLogo(data, "image/png")).metadata();
  assert.equal(meta.width, 400); assert.equal(meta.height, 200);
});

test("rejects MIME spoofing, SVG, damaged PNGs, over-size files and huge dimensions", async () => {
  const data = await png();
  await assert.rejects(normalizeReelLogo(data, "image/jpeg"), /PNG/);
  await assert.rejects(normalizeReelLogo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "image/png"), /PNG/);
  await assert.rejects(normalizeReelLogo(data.subarray(0, 35), "image/png"), /PNG válido/);
  const oversized = Buffer.alloc(MAX_REEL_LOGO_BYTES + 1); data.copy(oversized);
  await assert.rejects(normalizeReelLogo(oversized, "image/png"), /1 MB/);
  const huge = await sharp({ create: { width: 2049, height: 32, channels: 4, background: "red" } }).png().toBuffer();
  await assert.rejects(normalizeReelLogo(huge, "image/png"), /2048/);
});

test("no logo does not access Storage; foreign owner, request or external URL fail before download", async () => {
  const neverDownload = { storage: { from: () => { throw new Error("must not touch Storage"); } } } as unknown as SupabaseClient;
  assert.equal(await loadReelLogo(neverDownload, owner, request, null), undefined);
  for (const path of [`other/${request}/logo.png`, `${owner}/other/logo.png`, "https://example.com/logo.png", `${owner}/${request}/../logo.png`]) {
    await assert.rejects(loadReelLogo(neverDownload, owner, request, path), /no pertenece/);
  }
});

test("worker recovers the exact private PNG as self-contained render data; missing logo fails explicitly", async () => {
  const data = await png();
  let downloaded = "";
  const service = { storage: { from: (bucket: string) => {
    assert.equal(bucket, REEL_LOGO_BUCKET);
    return { download: async (path: string) => { downloaded = path; return { data: new Blob([new Uint8Array(data)]), error: null }; } };
  } } } as unknown as SupabaseClient;
  const src = await loadReelLogo(service, owner, request, reelLogoPath(owner, request));
  assert.equal(downloaded, `${owner}/${request}/logo.png`);
  assert.match(src!, /^data:image\/png;base64,/);
  assert.equal((await sharp(Buffer.from(src!.split(",")[1], "base64")).metadata()).hasAlpha, true);
  const missing = { storage: { from: () => ({ download: async () => ({ data: null, error: new Error("404") }) }) } } as unknown as SupabaseClient;
  await assert.rejects(loadReelLogo(missing, owner, request, reelLogoPath(owner, request)), /No se inició/);
});
