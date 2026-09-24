import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStoryboardFromFile, InvalidStoryboardFileError } from "./storyboard-loader";
import { buildShotsFromStoryboard } from "./storyboard-shots";

function withTempFile(content: string, fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "atomivid-storyboard-loader-test-"));
  const path = join(dir, "storyboard.json");
  writeFileSync(path, content);
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const VALID_MINIMAL = JSON.stringify({
  meta: { videoId: "test-001", totalShots: 2 },
  shots: [
    { beatId: "beat-1", shotId: "b1-s1", durationApprox: 10, assetType: "text", visualIntent: "hola" },
    { beatId: "beat-1", shotId: "b1-s2", durationApprox: 12, assetType: "stock_video", visualIntent: "mundo" },
  ],
});

test("loadStoryboardFromFile carga un storyboard válido y agrupa por beatId", () => {
  withTempFile(VALID_MINIMAL, (path) => {
    const loaded = loadStoryboardFromFile(path);
    assert.equal(loaded.videoId, "test-001");
    assert.equal(loaded.totalShots, 2);
    assert.equal(loaded.shotsByBeatId.size, 1);
    assert.equal(loaded.shotsByBeatId.get("beat-1")?.length, 2);
  });
});

test("loadStoryboardFromFile lanza InvalidStoryboardFileError con JSON malformado", () => {
  withTempFile("{ esto no es json", (path) => {
    assert.throws(() => loadStoryboardFromFile(path), InvalidStoryboardFileError);
  });
});

test("loadStoryboardFromFile lanza InvalidStoryboardFileError si falta un campo requerido", () => {
  const missing = JSON.stringify({ meta: { videoId: "x" }, shots: [] });
  withTempFile(missing, (path) => {
    assert.throws(() => loadStoryboardFromFile(path), InvalidStoryboardFileError);
  });
});

test("loadStoryboardFromFile carga el storyboard real de Göbekli Tepe (VIDEO #001) y produce shots utilizables por buildShotsFromStoryboard para TODOS los beats", () => {
  const realPath = join(process.cwd(), "content/long-form/gobekli-tepe-001/gobekli-storyboard-003.json");
  const loaded = loadStoryboardFromFile(realPath);
  assert.equal(loaded.videoId, "gobekli-tepe-001");
  assert.equal(loaded.totalShots, 45);

  let totalShotsSeen = 0;
  for (const [, shots] of loaded.shotsByBeatId) {
    totalShotsSeen += shots.length;
    // Cada beat debe poder construir shots reales con un span sintético razonable
    // (aquí solo se prueba que no lance por datos incompletos del loader).
    const built = buildShotsFromStoryboard({
      beatId: shots[0]?.shotId.split("-")[0] ?? "beat-x",
      beatType: "hook",
      startSec: 0,
      endSec: shots.reduce((s, sh) => s + sh.durationApprox, 0),
      storyboardShots: shots,
    });
    assert.equal(built.length, shots.length);
  }
  assert.equal(totalShotsSeen, 45);
  assert.equal(loaded.shotsByBeatId.size, 13, "el guion v3 tiene 13 beats");
});
