import { test } from "node:test";
import assert from "node:assert/strict";
import { compressAudioForStorage, isUncompressedWav } from "./audio-storage";

const wav = { audioBuffer: Buffer.alloc(1000, 1), mimeType: "audio/wav", extension: "wav" };

test("WAV is stored as MP3; already-compressed audio (real ElevenLabs/Beatoven MP3) is never re-encoded", async () => {
  let calls = 0;
  const enc = async () => { calls++; return Buffer.alloc(100, 2); };
  const out = await compressAudioForStorage(wav, enc);
  assert.deepEqual({ mime: out.mimeType, ext: out.extension, len: out.audioBuffer.byteLength, from: out.compressedFrom }, { mime: "audio/mpeg", ext: "mp3", len: 100, from: "wav" });
  const mp3 = { audioBuffer: Buffer.alloc(50), mimeType: "audio/mpeg", extension: "mp3" };
  assert.equal(await compressAudioForStorage(mp3, enc), mp3);
  assert.equal(calls, 1);
  assert.equal(isUncompressedWav("audio/x-wav", "bin"), true);
});

test("encoder failure, empty or larger output keeps the original bytes (compression never fails a render)", async () => {
  for (const enc of [async () => { throw new Error("no ffmpeg"); }, async () => Buffer.alloc(0), async () => Buffer.alloc(5000)]) {
    assert.equal(await compressAudioForStorage(wav, enc), wav);
  }
});
