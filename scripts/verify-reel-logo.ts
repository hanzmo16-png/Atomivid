/** Free smoke: PNG -> optional private Storage/DB round trip -> real Remotion MP4. No providers. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { createServiceClient } from "../src/lib/supabase/service";
import { loadReelLogo, normalizeReelLogo, REEL_LOGO_BUCKET, reelLogoPath } from "../src/lib/video/reel-logo";

async function main() {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "atomivid-logo-smoke-"));
  const logo = await normalizeReelLogo(await sharp(Buffer.from(
    '<svg width="400" height="200" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="8" width="384" height="184" rx="20" fill="#20c997"/><text x="200" y="122" text-anchor="middle" font-size="48" font-family="sans-serif" font-weight="bold" fill="white">MI MARCA</text></svg>',
  )).png().toBuffer(), "image/png");
  let customerLogoUrl = `data:image/png;base64,${logo.toString("base64")}`;
  let cleanup: (() => Promise<void>) | undefined;
  try {
    if (process.argv.includes("--storage")) {
      const service = createServiceClient();
      const userId = process.env.REEL_LOGO_VERIFY_USER_ID;
      assert.ok(userId, "REEL_LOGO_VERIFY_USER_ID required");
      const { data: auth, error: authError } = await service.auth.admin.getUserById(userId);
      assert.ok(!authError && auth.user?.id === userId, "Smoke owner must exist");
      const requestId = randomUUID();
      const logoPath = reelLogoPath(userId, requestId);
      cleanup = async () => {
        const removed = await service.from("video_requests").delete().eq("id", requestId).eq("user_id", userId);
        const fileRemoved = await service.storage.from(REEL_LOGO_BUCKET).remove([logoPath]);
        assert.equal(removed.error, null); assert.equal(fileRemoved.error, null);
      };
      const uploaded = await service.storage.from(REEL_LOGO_BUCKET).upload(logoPath, logo, { contentType: "image/png", upsert: false });
      assert.equal(uploaded.error, null);
      const inserted = await service.from("video_requests").insert({ id: requestId, user_id: userId,
        topic: "Comprobación temporal del logo", style: "Educativo", language: "es", duration_seconds: 30,
        mode: "visual", status: "pending", brand_logo_path: logoPath });
      assert.equal(inserted.error, null);
      const stored = await service.from("video_requests").select("user_id,brand_logo_path").eq("id", requestId).single();
      assert.equal(stored.error, null); assert.equal(stored.data?.brand_logo_path, logoPath);
      customerLogoUrl = (await loadReelLogo(service, stored.data!.user_id, requestId, stored.data!.brand_logo_path))!;
      const publicUrl = service.storage.from(REEL_LOGO_BUCKET).getPublicUrl(logoPath).data.publicUrl;
      assert.equal((await fetch(publicUrl)).ok, false, "Logo must not be publicly accessible");
      console.log("PRIVATE_STORAGE_AND_DB_ROUND_TRIP_PASS");
    }
    const background = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: "#182030" } }).png().toBuffer();
    const inputProps = { audioUrl: "", durationSeconds: 1, captions: [], scenes: [{
      mediaUrl: `data:image/png;base64,${background.toString("base64")}`,
      mediaType: "image", startSeconds: 0, endSeconds: 1,
    }] };
    const serveUrl = await bundle({ entryPoint: path.join(process.cwd(), "remotion/index.ts") });
    const composition = await selectComposition({ serveUrl, id: "VerticalReel", inputProps });
    const baseline = path.join(output, "without-logo.png");
    const start = path.join(output, "with-logo-start.png");
    const end = path.join(output, "with-logo-end.png");
    const brandedProps = { ...inputProps, customerLogoUrl, showLogo: true };
    // Remotion renders composition.props resolved by selectComposition, so resolve each variant.
    const brandedComposition = await selectComposition({ serveUrl, id: "VerticalReel", inputProps: brandedProps });
    await renderStill({ serveUrl, composition, inputProps, frame: 0, output: baseline, imageFormat: "png" });
    await renderStill({ serveUrl, composition: brandedComposition, inputProps: brandedProps, frame: 0, output: start, imageFormat: "png" });
    await renderStill({ serveUrl, composition: brandedComposition, inputProps: brandedProps, frame: 29, output: end, imageFormat: "png" });
    const logoCrop = { left: 64, top: 96, width: 200, height: 120 };
    const basePixels = await sharp(baseline).extract(logoCrop).raw().toBuffer();
    const startPixels = await sharp(start).extract(logoCrop).raw().toBuffer();
    const endPixels = await sharp(end).extract(logoCrop).raw().toBuffer();
    assert.notDeepEqual(startPixels, basePixels, "Logo must alter the rendered frame");
    assert.deepEqual(startPixels, endPixels, "Logo must remain on the last frame");
    const rightCrop = { left: 700, top: 64, width: 350, height: 200 };
    assert.deepEqual(await sharp(start).extract(rightCrop).raw().toBuffer(), await sharp(baseline).extract(rightCrop).raw().toBuffer(), "Customer logo replaces internal Atomivid badge");
    await renderMedia({ serveUrl, composition: brandedComposition, inputProps: brandedProps, codec: "h264", crf: 26,
      outputLocation: path.join(output, "with-logo.mp4"), concurrency: 2 });
    console.log("REEL_LOGO_RENDER_PASS", JSON.stringify({ output, providerCalls: 0, providerSpendUsd: 0 }));
  } finally {
    await cleanup?.();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
