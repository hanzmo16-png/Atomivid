import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import ffprobe from "@ffprobe-installer/ffprobe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { memoryLedgerStore } from "@/lib/production-intelligence/ledger";
import { memoryResultStore } from "@/lib/paid-calls/result-store";
import { reviewVisual } from "./visual-review";
import { visualReviewFrames, VisualAssetQualityError } from "./visual-review-media";

const image = (width: number, height: number) => sharp({ create: { width, height, channels: 4, background: { r: 100, g: 40, b: 180, alpha: 0.5 } } }).png().toBuffer();

test("native vertical crop must retain HD pixels; a wide 1080p file and a tiny portrait cannot qualify by upscaling", async () => {
  for (const [width, height] of [[1920, 1080], [320, 568]]) {
    await assert.rejects(visualReviewFrames(await image(width, height), "image", 3), VisualAssetQualityError);
  }
  const views = await visualReviewFrames(await image(1024, 1536), "image", 3);
  assert.equal(views.length, 2, "base crop and maximum hook zoom are both inspected");
  for (const view of views) {
    const meta = await sharp(Buffer.from(view.split(",")[1], "base64")).metadata();
    assert.equal(meta.width, 512); assert.equal(meta.height, 910);
  }
});

test("EXIF rotation is respected before checking resolution and cropping the pixels", async () => {
  const rotated = await sharp(await image(1280, 720)).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  assert.equal((await visualReviewFrames(rotated, "image", 3, 1)).length, 2);
});

test("bad downloaded bytes stop before reserving or buying a vision review", async () => {
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "test-key";
  try {
    let calls = 0, reservations = 0;
    const ledger = memoryLedgerStore();
    const args = { service: {} as SupabaseClient, requestId: "r", sceneIndex: 0,
      intent: { source: "stock" as const, subject: "grey alien figure", mustShow: ["large eyes"], mustNotShow: [], imagePrompt: "A grey alien with large eyes." },
      narration: "Un ser gris", mediaType: "image" as const, durationSeconds: 3,
      results: memoryResultStore(), ledger: { ...ledger, insert: async (op: Parameters<typeof ledger.insert>[0]) => { reservations++; return ledger.insert(op); } },
      fetcher: (async () => { calls++; throw Error("must not buy a review"); }) as typeof fetch };
    for (const buffer of [Buffer.from("not an image"), await image(320, 568)]) {
      await assert.rejects(reviewVisual({ ...args, buffer }), VisualAssetQualityError);
    }
    assert.equal(calls, 0); assert.equal(reservations, 0);
  } finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; }
});

test("an unavailable media inspector is an operational failure, not a defective candidate eligible for paid fallback", async () => {
  const oldPath = ffprobe.path;
  try {
    ffprobe.path = "/atomivid-nonexistent-inspector";
    await assert.rejects(visualReviewFrames(Buffer.from("asset"), "video", 3), error => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof VisualAssetQualityError, false);
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
      return true;
    });
  } finally { ffprobe.path = oldPath; }
});

test("video sampling includes the end of the used range and checks real stream duration", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "atomivid-review-test-"));
  try {
    const clip = path.join(directory, "clip.mp4");
    await promisify(execFile)(ffmpeg.path, ["-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=red:s=720x1280:d=1:r=10",
      "-f", "lavfi", "-i", "color=c=green:s=720x1280:d=1:r=10",
      "-f", "lavfi", "-i", "color=c=blue:s=720x1280:d=1:r=10",
      "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-c:v", "libx264", "-threads", "2", "-y", clip], { timeout: 20_000 });
    const bytes = await fs.readFile(clip);
    const views = await visualReviewFrames(bytes, "video", 3);
    assert.equal(views.length, 6);
    const colors = await Promise.all(views.map(async view => {
      const { data } = await sharp(Buffer.from(view.split(",")[1], "base64")).raw().toBuffer({ resolveWithObject: true });
      return [data[0], data[1], data[2]];
    }));
    assert.ok(colors[0][0] > 200 && colors[1][0] > 200, "both beginning views show red");
    assert.ok(colors[2][1] > 100 && colors[3][1] > 100, "both middle views show green");
    assert.ok(colors[4][2] > 200 && colors[5][2] > 200, "both end views show blue");
    const shorterUse = await visualReviewFrames(bytes, "video", 1);
    const { data } = await sharp(Buffer.from(shorterUse[4].split(",")[1], "base64")).raw().toBuffer({ resolveWithObject: true });
    assert.ok(data[0] > 200 && data[2] < 30, "the end sample belongs to the used first second, not the unused tail");
    await assert.rejects(visualReviewFrames(bytes, "video", 3.5), /demasiado corto/);
    await assert.rejects(visualReviewFrames(Buffer.from("bad mp4"), "video", 3), VisualAssetQualityError);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
