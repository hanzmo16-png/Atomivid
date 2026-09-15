import assert from "node:assert/strict";
import test from "node:test";

import { selectPortraitVideoFile } from "./footage";

test("elige el MP4 vertical más cercano a 1080px de ancho", () => {
  const selected = selectPortraitVideoFile([
    { link: "landscape.mp4", width: 1920, height: 1080, file_type: "video/mp4", quality: "hd" },
    { link: "portrait-720.mp4", width: 720, height: 1280, file_type: "video/mp4", quality: "hd" },
    { link: "portrait-1080.mp4", width: 1080, height: 1920, file_type: "video/mp4", quality: "hd" },
    { link: "portrait.webm", width: 1080, height: 1920, file_type: "video/webm", quality: "hd" },
  ]);

  assert.equal(selected?.link, "portrait-1080.mp4");
});

test("rechaza formatos, paisajes y clips demasiado pequeños", () => {
  const selected = selectPortraitVideoFile([
    { link: "landscape.mp4", width: 1920, height: 1080, file_type: "video/mp4", quality: "hd" },
    { link: "small.mp4", width: 360, height: 640, file_type: "video/mp4", quality: "sd" },
    { link: "portrait.webm", width: 1080, height: 1920, file_type: "video/webm", quality: "hd" },
  ]);

  assert.equal(selected, null);
});
