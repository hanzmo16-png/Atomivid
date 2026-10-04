import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { memoryResultStore } from "@/lib/paid-calls/result-store";
import type { LedgerStore, PaidOperation } from "@/lib/production-intelligence/ledger";
import { reviewVisual, visualReviewFrames, REVIEW_MODEL } from "./visual-review";
import type { VisualIntent } from "./visual-intent";

const intent: VisualIntent = { source: "illustration", subject: "grey alien figure", mustShow: ["large head", "large black eyes"], mustNotShow: ["lamp"], imagePrompt: "A grey alien figure with a large head and large black eyes." };
const verdict = { subjectPresent: true, allRequiredTraitsPresent: true, forbiddenSubstitutePresent: false, unrelatedTextOrWatermark: false, confidence: 0.95, reason: "Alien figure visible." };
function ledger() {
  const rows = new Map<string, PaidOperation>();
  const port: LedgerStore = { get: async key => rows.get(key) ?? null, insert: async op => { if (rows.has(op.idempotencyKey)) return false; rows.set(op.idempotencyKey, op); return true; }, update: async (key, expected, patch) => { const row = rows.get(key); if (!row || row.status !== expected) return false; rows.set(key, { ...row, ...patch }); return true; } };
  return { port, rows };
}

test("actual transparent image is decoded and center-cropped for vision; corrupt bytes fail before any provider call", async () => {
  const image = await sharp({ create: { width: 1024, height: 512, channels: 4, background: "purple" } }).png().toBuffer();
  const frames = await visualReviewFrames(image, "image", 3);
  assert.equal(frames.length, 1);
  const meta = await sharp(Buffer.from(frames[0].split(",")[1], "base64")).metadata();
  assert.equal(meta.width, 384); assert.equal(meta.height, 683);
  await assert.rejects(visualReviewFrames(Buffer.from("not an image"), "image", 3));
});

test("clip review extracts different actual frames from the used time range", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "atomivid-review-test-"));
  try {
    const clip = path.join(directory, "clip.mp4");
    await promisify(execFile)(ffmpeg.path, ["-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=red:s=640x360:d=1:r=10",
      "-f", "lavfi", "-i", "color=c=blue:s=640x360:d=1:r=10",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-c:v", "libx264", "-y", clip], { timeout: 20_000 });
    const frames = await visualReviewFrames(await fs.readFile(clip), "video", 2.2);
    assert.equal(frames.length, 2);
    const colors = await Promise.all(frames.map(async frame => {
      const { data } = await sharp(Buffer.from(frame.split(",")[1], "base64")).raw().toBuffer({ resolveWithObject: true });
      return [data[0], data[1], data[2]];
    }));
    assert.ok(colors[0][0] > 200 && colors[0][2] < 30, "first frame shows red footage");
    assert.ok(colors[1][2] > 200 && colors[1][0] < 30, "middle frame shows blue footage");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("vision receives image pixels plus literal requirements; retries reuse the persisted verdict at zero extra calls", async () => {
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "test-key";
  try {
    const { port, rows } = ledger(); const results = memoryResultStore(); let calls = 0;
    const fetcher: typeof fetch = async (_url, options) => {
      calls++; const body = JSON.parse(String(options?.body));
      assert.equal(body.model, REVIEW_MODEL); assert.equal(body.store, false);
      assert.equal([...rows.values()].filter(row => row.status === "SUBMITTED").length, 1);
      assert.match(body.input[0].content[0].text, /grey alien/);
      assert.match(body.input[0].content[1].image_url, /^data:image\/jpeg;base64,/);
      return new Response(JSON.stringify({ status: "completed", usage: { input_tokens: 900, output_tokens: 100 }, output: [{ content: [{ type: "output_text", text: JSON.stringify(verdict) }] }] }), { status: 200 });
    };
    const args = { service: {} as SupabaseClient, requestId: "request", sceneIndex: 0, intent, narration: "A grey alien", buffer: Buffer.from("asset"), mediaType: "image" as const, durationSeconds: 3, ledger: port, results, fetcher, frames: async () => ["data:image/jpeg;base64,cGl4ZWxz"] };
    assert.equal((await reviewVisual(args)).accepted, true);
    const reused = await reviewVisual(args); assert.equal(reused.reused, true); assert.equal(reused.costUsd, 0); assert.equal(calls, 1);
    const changed = await reviewVisual({ ...args, intent: { ...intent, subject: "another alien" } });
    assert.equal(changed.reused, false); assert.equal(calls, 2);
  } finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; }
});

test("reservation failure blocks HTTP; uncertain HTTP never retries automatically", async () => {
  const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "test-key";
  try {
    const { port } = ledger(); let calls = 0;
    const args = { service: {} as SupabaseClient, requestId: "request", sceneIndex: 0, intent, narration: "A grey alien", buffer: Buffer.from("asset"), mediaType: "image" as const, durationSeconds: 3, results: memoryResultStore(), frames: async () => ["data:image/jpeg;base64,cGl4ZWxz"], fetcher: (async () => { calls++; throw Error("connection cut"); }) as typeof fetch };
    await assert.rejects(reviewVisual({ ...args, ledger: { ...port, insert: async () => { throw Error("budget blocked"); } } }), /budget blocked/); assert.equal(calls, 0);
    await assert.rejects(reviewVisual({ ...args, ledger: port }), /connection cut/);
    await assert.rejects(reviewVisual({ ...args, ledger: port })); assert.equal(calls, 1);
  } finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; }
});
