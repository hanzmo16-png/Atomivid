import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (...p: string[]) => readFileSync(path.join(__dirname, ...p), "utf8");

test("el selector solo aparece en Reel (mode visual) y con el flag; Avatar conserva su formulario", () => {
  const form = read("NewVideoForm.tsx");
  assert.match(form, /\{audiovisual && mode === "visual" && \(\n\s+<AudiovisualSelector/);
  const page = read("page.tsx");
  assert.match(page, /flags\.audiovisualProfilesEnabled\s+\? \{ availabilityByDuration: profileAvailabilityByDuration\(ALLOWED_DURATIONS\), animationByDuration: animationAvailabilityByDuration\(ALLOWED_DURATIONS\) \}\s+: undefined/);
});

test("selector: cinco opciones con nombres de formulario validados en servidor, ajustes cerrados y muestras solo reales", () => {
  const src = readFileSync(path.join(__dirname, "..", "..", "..", "components", "video", "AudiovisualSelector.tsx"), "utf8");
  for (const name of ["av_profile", "av_intent", "av_music", "av_pace"]) assert.ok(src.includes(`name="${name}"`), name);
  assert.match(src, /<details className=/, "ajustes opcionales cerrados por defecto (sin atributo open)");
  assert.ok(!/<details[^>]*\bopen\b/.test(src));
  assert.match(src, /Muestra real pendiente/);
  assert.match(src, /PROFILE_SAMPLES\[id\]/);
});
