import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNoaaEvidence, assertNoaaUrl, fetchNoaaBytes, type NoaaVideoSource } from "./noaa-video";
import { findOceanSound, renderOceanSound } from "./ocean-sounds";
import { overlayIssue } from "../../../../remotion/scene-overlay";
import { validateSampleManifest, type SampleManifest } from "./sample-manifest";

const source: NoaaVideoSource = { kind: "noaa-video", url: "https://oceanexplorer.noaa.gov/media/fish.mp4", pageUrl: "https://oceanexplorer.noaa.gov/fish/", credit: "NOAA Ocean Exploration", licenseReview: { date: "2026-09-27", note: "Reviewed this specific credit and media; no third-party exception on the page." } };

test("NOAA importer requires a per-file review, matching credit and linked media", () => {
  const html = '<p>Courtesy NOAA Ocean Exploration</p><a href="/media/fish.mp4">Download</a>';
  assert.doesNotThrow(() => assertNoaaEvidence(source, html));
  assert.throws(() => assertNoaaEvidence(source, html.replace("NOAA Ocean Exploration", "Other owner")));
  assert.throws(() => assertNoaaEvidence(source, html.replace("fish.mp4", "other.mp4")));
  assert.throws(() => assertNoaaEvidence({ ...source, licenseReview: { date: "", note: "" } }, html));
  for (const url of ["http://oceanexplorer.noaa.gov/f.mp4", "https://oceanexplorer.noaa.gov.evil.test/f.mp4", "https://oceanexplorer.noaa.gov@evil.test/", "https://127.0.0.1/", "https://oceanexplorer.noaa.gov:444/f.mp4"]) assert.throws(() => assertNoaaUrl(url));
});

test("NOAA fetch rejects redirects off the reviewed host and bounded streaming overflow", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: "https://example.com/media.mp4" } });
    await assert.rejects(fetchNoaaBytes(source.url, 10), /NOAA source/);
    globalThis.fetch = async () => new Response(new Uint8Array(11));
    await assert.rejects(fetchNoaaBytes(source.url, 10), /size limit/);
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]));
    assert.equal((await fetchNoaaBytes(source.url, 10)).length, 3);
  } finally { globalThis.fetch = original; }
});

test("overlays reject unreadable length and invalid time windows", () => {
  assert.equal(overlayIssue({ text: "About 0.001%", source: "Bell et al., 2025", startSeconds: 0.5, endSeconds: 4 }, 5), undefined);
  for (const overlay of [{ text: "" }, { text: "x".repeat(73) }, { text: "Title", endSeconds: 6 }, { text: "Title", startSeconds: NaN }, { text: "Title", startSeconds: 2, endSeconds: 1 }]) assert.ok(overlayIssue(overlay, 5));
});

test("ocean cards are short; longer information goes over media", () => {
  const manifest: SampleManifest = { requestId: "ocean-deep-001", beats: ["b1"], tailSeconds: 0, outputPrefix: "ocean-deep-001/samples/episode", soundCues: [], missingSound: [], scenes: [{ id: "s1", startSeconds: 0, endSeconds: 3, narration: "", provenance: "data_graphic", source: { kind: "graphic", spec: { kind: "text", title: "Title", body: "Brief", size: "large", isFixture: false } }, direction: {}, review: { status: "approved", relevance: "directa", note: "test" } }] };
  assert.ok(validateSampleManifest(manifest, [], 3).some(i => i.code === "ocean_card_duration"));
  manifest.scenes[0].endSeconds = 1.5;
  assert.ok(!validateSampleManifest(manifest, [], 1.5).some(i => i.code === "ocean_card_duration"));
  manifest.scenes[0].source = source;
  manifest.scenes[0].endSeconds = 5;
  manifest.scenes[0].overlay = { text: "Brief" };
  assert.deepEqual(validateSampleManifest(manifest, [], 5), []);
});

test("own ambient sound is deterministic PCM without clipping and loops continuously", () => {
  for (const id of ["atomivid-ocean-ambience-v1", "atomivid-ocean-sonar-v1"]) {
    const sound = findOceanSound(id)!;
    const wav = renderOceanSound(sound);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.length, 44 + sound.seconds * 44100 * 2);
    assert.deepEqual(wav, renderOceanSound(sound));
    let peak = 0;
    for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
    assert.ok(peak > 100 && peak < 16000);
    assert.ok(Math.abs(wav.readInt16LE(44) - wav.readInt16LE(wav.length - 2)) < 100);
  }
});
