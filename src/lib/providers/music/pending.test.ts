// Pending CC BY tracks are published only after a successful ingest (object present with the pinned size). USD 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PENDING_MUSIC_TRACKS, publishedPendingTracks } from "./pending";
import { MUSIC_MANIFEST } from "./manifest";
import { selectMusicTrack } from "./select";
import { inferTone } from "./tone";

const svc = (objects: { name: string; metadata?: { size?: number } }[] | null, error: unknown = null) =>
  ({ storage: { from: () => ({ list: async () => ({ data: objects, error }) }) } }) as never;

test("only instrumental, non-excluded tracks are candidates; each carries the exact CC BY credit and a pinned sha256", () => {
  assert.deepEqual(PENDING_MUSIC_TRACKS.map((t) => t.id), ["silverman-passage-of-arms"], "The Fall Of Heroes (choir) is excluded");
  for (const t of PENDING_MUSIC_TRACKS) {
    assert.match(t.attribution!, /^Music: .+ by Shane Ivers - https:\/\/www\.silvermansound\.com — licensed under CC BY 4\.0 \(https:\/\/creativecommons\.org\/licenses\/by\/4\.0\/\)$/);
    assert.match(t.sha256!, /^[0-9a-f]{64}$/); assert.ok(t.bytes! > 1e6);
    assert.ok(!MUSIC_MANIFEST.some((m) => m.id === t.id), "never hard-wired into the manifest");
  }
});

test("before ingest (missing / wrong size / listing error) nothing is published; after a verified ingest it is", async () => {
  const t = PENDING_MUSIC_TRACKS[0];
  assert.deepEqual(await publishedPendingTracks(svc([])), []);
  assert.deepEqual(await publishedPendingTracks(svc([{ name: t.storagePath, metadata: { size: t.bytes! - 1 } }])), [], "a partial or different object is not published");
  assert.deepEqual(await publishedPendingTracks(svc(null, { message: "down" })), []);
  const after = await publishedPendingTracks(svc([{ name: t.storagePath, metadata: { size: t.bytes } }, { name: "other.mp3", metadata: { size: 1 } }]));
  assert.deepEqual(after.map((x) => x.id), [t.id]);
  // Once published, a battle documentary's epic tone selects it.
  const tones = inferTone({ topic: "Attila the Hun vs the 300 Spartans at Thermopylae", scriptText: "cavalry charge battle phalanx war" });
  assert.ok(tones.includes("epic"), `tones: ${tones}`);
  const pick = selectMusicTrack({ manifest: [...MUSIC_MANIFEST, ...after], tones, seed: "req" });
  assert.equal(pick.status === "matched" && pick.track.id, t.id);
});
