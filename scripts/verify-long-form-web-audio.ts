/** Free real-render check: a short HTTP-served bed must remain audible past two repeats. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { generateToneWav } from "../src/lib/providers/wav";
import { renderLongFormDoc } from "../src/lib/video/long-form/render";

async function main() {
  const voice = generateToneWav({ durationSeconds: 6, frequencyHz: 880, amplitude: 0.03 });
  const music = generateToneWav({ durationSeconds: 2, frequencyHz: 220, amplitude: 0.2 });
  const server = createServer((request, response) => {
    if (request.url !== "/voice.wav" && request.url !== "/music.wav") { response.writeHead(404).end(); return; }
    const bytes = request.url === "/voice.wav" ? voice : music;
    response.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": bytes.length });
    response.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  let output: string | undefined;
  try {
    output = await renderLongFormDoc({
      audioUrl: `${origin}/voice.wav`, musicUrl: `${origin}/music.wav`, musicDurationSeconds: 2,
      language: "en", durationSeconds: 6, narrationGaps: [],
      captions: [{ text: "Free render verification", startSeconds: 0, endSeconds: 6 }],
      scenes: [{ id: "check", startSeconds: 0, endSeconds: 6, motion: "static", provenance: "ai_recreation",
        asset: { kind: "graphic", graphic: { kind: "text", title: "Audio continuity", body: "Testing three consecutive music segments", isFixture: true, size: "large" } } }],
    });
    const levels = [1.5, 3.5, 4.5].map(start => {
      const report = spawnSync("ffmpeg", ["-hide_banner", "-ss", String(start), "-t", "0.2", "-i", output!,
        "-vn", "-af", "bandpass=f=220:width_type=h:w=30,volumedetect", "-f", "null", "-"], { encoding: "utf8" });
      assert.equal(report.status, 0, report.stderr);
      const match = report.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
      assert.ok(match, "Volume measurement missing");
      return Number(match[1]);
    });
    assert.ok(levels.every(level => level > -45), `Music disappeared: ${levels}`);
    assert.ok(Math.max(...levels) - Math.min(...levels) < 3, `Music changed between repetitions: ${levels}`);
    console.log(JSON.stringify({ realRender: true, sourceSeconds: 2, videoSeconds: 6, musicLevelsDb: levels, paidCalls: 0 }));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (output) await rm(output, { force: true });
  }
}
// Remotion can retain server handles after startup failure; make CI fail promptly.
main().catch(error => { console.error(error); process.exit(1); });
