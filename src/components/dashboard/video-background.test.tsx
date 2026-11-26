import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { VideoBackground } from "./VideoBackground";
import { backgroundSources, shouldPlayVideo, VIDEO_BACKGROUND_ORIENTATIONS } from "./video-background";

test("fondo en video: movimiento reducido, ahorro de datos o 2G se quedan con el póster", () => {
  assert.equal(shouldPlayVideo({ reducedMotion: false }), true);
  assert.equal(shouldPlayVideo({ reducedMotion: true }), false);
  assert.equal(shouldPlayVideo({ reducedMotion: false, saveData: true }), false);
  assert.equal(shouldPlayVideo({ reducedMotion: false, effectiveType: "2g" }), false);
  assert.equal(shouldPlayVideo({ reducedMotion: false, effectiveType: "slow-2g" }), false);
  assert.equal(shouldPlayVideo({ reducedMotion: false, effectiveType: "4g" }), true);
});

test("fondo en video: cada archivo existe y pesa ≤ 2.5 MB", () => {
  for (const o of VIDEO_BACKGROUND_ORIENTATIONS) {
    for (const path of Object.values(backgroundSources(o))) {
      const size = statSync(join(process.cwd(), "public", path)).size;
      assert.ok(size > 0 && size <= 2.5 * 1024 * 1024, `${path}: ${size} B`);
    }
  }
});

test("fondo en video: en servidor solo el póster (sin <video>), decorativo y detrás del contenido", () => {
  const html = renderToStaticMarkup(<VideoBackground />);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /pointer-events-none fixed inset-0 -z-10/);
  assert.match(html, /<source media="\(orientation: portrait\)" srcSet="\/cinematic\/cosmos2-portrait-poster\.jpg"/);
  assert.match(html, /<img src="\/cinematic\/cosmos2-landscape-poster\.jpg"/);
  assert.doesNotMatch(html, /<video/, "el video se monta solo en el cliente, tras comprobar movimiento reducido");
});
