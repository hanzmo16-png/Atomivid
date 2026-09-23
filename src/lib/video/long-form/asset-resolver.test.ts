import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveShotAsset, type AssetUploader } from "./asset-resolver";
import { fixtureFootageProvider } from "@/lib/providers/footage/fixture";
import { fixtureImageProvider } from "@/lib/providers/image/fixture";
import { shotsForSpan } from "./shots";
import type { Shot } from "./types";

function makeUploader(): { upload: AssetUploader; uploaded: { path: string; bytes: number }[] } {
  const uploaded: { path: string; bytes: number }[] = [];
  const upload: AssetUploader = async (objectPath, buffer) => {
    uploaded.push({ path: objectPath, bytes: buffer.byteLength });
    return { url: `mock://storage/${objectPath}` };
  };
  return { upload, uploaded };
}

// 32s a ~4s por shot da 8 shots — suficiente para recorrer el ciclo
// completo de los 7 shot.type (incluye stock_video, que un span de 24s
// (6 shots) no alcanza a cubrir).
function shotsOfBeat(): Shot[] {
  return shotsForSpan({
    beatId: "beat-1",
    beatType: "hook",
    startSec: 0,
    endSec: 32,
    narration: "Narración de prueba para generar shots reales.",
  });
}

test("cada shot.type real del beat se resuelve sin lanzar, usando proveedores fixture", async () => {
  const shots = shotsOfBeat();
  assert.ok(shots.length >= 6, "shotsForSpan debe producir varios shots reales para este span");
  const { upload } = makeUploader();

  for (const shot of shots) {
    const result = await resolveShotAsset(shot, {
      footageProvider: fixtureFootageProvider,
      imageProvider: fixtureImageProvider,
      upload,
      pathPrefix: "test-prefix",
      imageBudgetRemainingUsd: 5,
    });
    assert.equal(result.shotId, shot.id);
    assert.equal(result.costUsd, 0, `shot ${shot.id} (${shot.type}) no debería costar nada con proveedores fixture`);
  }
});

test("text/diagram/map resuelven a 'graphic' (determinístico, sin proveedor de red)", async () => {
  const shots = shotsOfBeat();
  const { upload } = makeUploader();
  const textShot = shots.find((s) => s.type === "text");
  const diagramShot = shots.find((s) => s.type === "diagram");
  const mapShot = shots.find((s) => s.type === "map");
  assert.ok(textShot && diagramShot && mapShot, "el ciclo de shotsForSpan debe cubrir text/diagram/map en 24s");

  for (const shot of [textShot!, diagramShot!, mapShot!]) {
    const result = await resolveShotAsset(shot, {
      footageProvider: fixtureFootageProvider,
      imageProvider: fixtureImageProvider,
      upload,
      pathPrefix: "p",
      imageBudgetRemainingUsd: 5,
    });
    assert.equal(result.asset.kind, "graphic");
    assert.equal(result.providerUsed, "deterministic");
    assert.equal(result.bufferBytes, 0);
  }
});

test("stock_image/stock_video/ken_burns_image/generated_placeholder resuelven a 'media' con una URL subida", async () => {
  const shots = shotsOfBeat();
  const { upload, uploaded } = makeUploader();
  const mediaTypes: Shot["type"][] = ["stock_image", "stock_video", "ken_burns_image", "generated_placeholder"];

  for (const type of mediaTypes) {
    const shot = shots.find((s) => s.type === type);
    assert.ok(shot, `el ciclo debe cubrir ${type} en 24s`);
    const result = await resolveShotAsset(shot!, {
      footageProvider: fixtureFootageProvider,
      imageProvider: fixtureImageProvider,
      upload,
      pathPrefix: "p",
      imageBudgetRemainingUsd: 5,
    });
    assert.equal(result.asset.kind, "media");
    if (result.asset.kind === "media") {
      assert.ok(result.asset.url.startsWith("mock://storage/"));
    }
  }
  assert.equal(uploaded.length, mediaTypes.length);
});

test("generated_placeholder usa aspectRatio 16:9 (landscape) — no el 9:16 de Shorts", async () => {
  const shots = shotsOfBeat();
  const shot = shots.find((s) => s.type === "generated_placeholder")!;
  const { upload } = makeUploader();
  const result = await resolveShotAsset(shot, {
    footageProvider: fixtureFootageProvider,
    imageProvider: fixtureImageProvider,
    upload,
    pathPrefix: "p",
    imageBudgetRemainingUsd: 5,
  });
  assert.equal(result.asset.kind, "media");
});

test("resolveShotAsset con un graphicSpecFor personalizado (research pack real) reemplaza el fixture por defecto", async () => {
  const shots = shotsOfBeat();
  const textShot = shots.find((s) => s.type === "text")!;
  const { upload } = makeUploader();
  const result = await resolveShotAsset(textShot, {
    footageProvider: fixtureFootageProvider,
    imageProvider: fixtureImageProvider,
    upload,
    pathPrefix: "p",
    imageBudgetRemainingUsd: 5,
    graphicSpecFor: () => ({ kind: "text", title: "Real", body: "Contenido real verificado", isFixture: false }),
  });
  assert.equal(result.asset.kind, "graphic");
  if (result.asset.kind === "graphic" && result.asset.graphic.kind === "text") {
    assert.equal(result.asset.graphic.isFixture, false);
  }
});
