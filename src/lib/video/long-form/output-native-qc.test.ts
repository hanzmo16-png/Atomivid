import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import { finalizeLongFormOutput, memoryOutputDeps, reconcileExistingOutput, NativeOutputQcError, assertNativeOutputQc } from "./output-finalize";

import { probeOutput } from "./output-media";

// CI runners need not install a system ffprobe; use the versioned real binary.
process.env.FFPROBE_BIN = ffprobeInstaller.path;

const run = promisify(execFile);
const requestId = "native-qc-offline";

test("native delivery fails closed on detector failure before upload and records diagnostic", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lf-native-seam-"));
  try {
    const filePath = path.join(dir, "final.mp4");
    await fs.writeFile(filePath, "synthetic test seam only");
    const out = memoryOutputDeps();
    out.deps.assertFileQc = async (p) => { assert.equal(p, filePath); throw new Error("detector timeout"); };
    await assert.rejects(finalizeLongFormOutput({ requestId, attempt: 1, filePath }, out.deps));
    assert.equal(out.calls.upload, 0);
    assert.equal(out.calls.transcode, 0);
    assert.equal(out.states.get(requestId)?.failure?.detail.reason, "native_black_qc_failed");
    assert.equal(out.states.get(requestId)?.status, "FAILED");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("QC runs on the exact size-fit file before its canonical upload", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lf-native-fit-"));
  try {
    const filePath = path.join(dir, "final.mp4");
    await fs.writeFile(filePath, Buffer.alloc(60 * 1024 * 1024));
    const out = memoryOutputDeps({ storageLimitBytes: 50 * 1024 * 1024 });
    out.deps.storageMaxBytes = 50 * 1024 * 1024;
    out.deps.assertFileQc = async (p) => {
      assert.equal(p, path.join(dir, "final.fit.mp4"));
      assert.equal(out.calls.upload, 0);
      throw new Error("black interval in fitted output");
    };
    await assert.rejects(finalizeLongFormOutput({ requestId, attempt: 1, filePath }, out.deps));
    assert.equal(out.calls.transcode, 1);
    assert.equal(out.calls.upload, 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("storage size rejection checks both original and fitted bytes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lf-native-retry-"));
  try {
    const filePath = path.join(dir, "final.mp4");
    await fs.writeFile(filePath, Buffer.alloc(60 * 1024 * 1024));
    const out = memoryOutputDeps({ storageLimitBytes: 50 * 1024 * 1024 });
    const checked: string[] = [];
    out.deps.assertFileQc = async (p) => {
      checked.push(p);
      if (p.endsWith(".fit.mp4")) throw new Error("fitted output rejected by QC");
    };
    await assert.rejects(finalizeLongFormOutput({ requestId, attempt: 1, filePath }, out.deps));
    assert.deepEqual(checked, [filePath, path.join(dir, "final.fit.mp4")]);
    assert.equal(out.calls.upload, 1, "only original storage rejection; fitted output never uploads");
    assert.equal(out.states.get(requestId)?.failure?.detail.reason, "native_black_qc_failed");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("legacy delivery records cannot bypass object QC through the trusted-state shortcut", async () => {
  const out = memoryOutputDeps();
  out.objects.set(`${requestId}/output/final.mp4`, 100);
  out.deps.readState = async () => ({ status: "UPLOADED", delivered: { bytes: 100, durationSeconds: 4, videoCodec: "h264" } } as never);
  const blocked = new NativeOutputQcError(new Error("black interval in legacy output"));
  out.deps.probeObject = async () => { throw blocked; };
  await assert.rejects(reconcileExistingOutput(requestId, out.deps), (err) => err === blocked);
  assert.equal(out.calls.upload, 0);
  assert.equal(out.calls.transcode, 0);
  assert.equal(out.objects.get(`${requestId}/output/final.mp4`), 100);
  assert.equal(out.states.size, 0, "reconciliation preserves existing state");
});

// Real local MP4s exercise the default delivery gate. These are offline detector
// samples, not evidence of a commercial production or generated customer media.
for (const color of ["black", "white"]) {
  test(`real ${color} MP4 is evaluated by default native delivery QC`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lf-native-real-"));
    try {
      const filePath = path.join(dir, "final.mp4");
      await run(ffmpegInstaller.path, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=160x90:r=10:d=4`, "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", filePath], { timeout: 30_000 });
      const out = memoryOutputDeps({ durationSeconds: 4 });
      delete out.deps.assertFileQc;
      out.deps.probe = probeOutput;
      if (color === "black") {
        await assert.rejects(finalizeLongFormOutput({ requestId, attempt: 1, filePath }, out.deps));
        assert.equal(out.calls.upload, 0);
        assert.match(String(out.states.get(requestId)?.failure?.detail.message), /native_black_qc_failed|black_interval_too_long/);
        out.objects.set(`${requestId}/output/final.mp4`, (await fs.stat(filePath)).size);
        out.deps.probeObject = async () => { await assertNativeOutputQc(filePath); return probeOutput(filePath); };
        await assert.rejects(reconcileExistingOutput(requestId, out.deps), NativeOutputQcError);
        assert.equal(out.calls.upload, 0);
      } else {
        const result = await finalizeLongFormOutput({ requestId, attempt: 1, filePath }, out.deps);
        assert.equal(result.state.nativeBlackQc, "passed-v1");
        assert.equal(out.calls.upload, 1);
      }
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
}
