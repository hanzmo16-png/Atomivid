import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// F3 (T-20261019-1602): media_qa [10] encontró el MP4 del Reel con moov al final (mdat en el byte 44).
test("el master del video corto pide faststart (moov al inicio)", () => {
  const src = readFileSync(path.join(process.cwd(), "src/lib/video/generate-video.ts"), "utf8");
  assert.match(src, /masterAudioLoudness\(rawOutputPath, masteredPath, \{ faststart: true \}\)/);
});
