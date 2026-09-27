/** Export the actual approved caption grouping and word times; no providers. */
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { buildCaptions } from "../src/lib/video/captions";
import { captionsWithinScenes, withCaptionWords } from "../src/lib/video/long-form/scene-captions";
import type { WordTiming } from "../src/lib/providers/types";

async function main() {
const dir = process.argv[2];
assert.ok(dir, "Usage: tsx scripts/ocean-opening-captions.ts ASSET_DIRECTORY");
const edit = JSON.parse(await fs.readFile("docs/quality/ocean-deep-001/opening-review.json", "utf8"));
const words: WordTiming[] = JSON.parse(await fs.readFile(path.join(dir, "words-b1.json"), "utf8"));
const selected = words.filter(w => w.endSeconds <= edit.durationSeconds);
const captions = withCaptionWords(captionsWithinScenes(selected, edit.scenes, w => buildCaptions(w, new Set())), selected);
assert.ok(captions.every(c => c.words && c.words.map(w => w.text).join(" ") === c.text));
assert.equal(captions.flatMap(c => c.words ?? []).length, selected.length);
await fs.writeFile(path.join(dir, "opening-captions.json"), JSON.stringify(captions, null, 2));
console.log(JSON.stringify({ captions: captions.length, words: selected.length, lastWord: selected.at(-1)?.text, paidCalls: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
