/** T-20261101-0215: «Solo audio» dice qué entrega (MP3/WAV, una o dos voces, nada visual) y no promete el rostro del anfitrión. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { AUDIO_ONLY_NOTE, AudioOnlyNote, HostChosenNote, hostChosenText } from "./PodcastWizard";

test("Solo audio: la explicación dice MP3/WAV, una o dos voces y sin video, imágenes ni avatar", () => {
  const html = renderToStaticMarkup(<AudioOnlyNote />);
  assert.match(html, /data-testid="solo-audio-explicacion"/);
  assert.match(html, /MP3 o WAV/);
  assert.match(html, /una o dos voces/);
  assert.match(html, /No se genera video, imágenes ni avatar/);
  assert.equal(AUDIO_ONLY_NOTE.includes("rostro"), false);
});

test("anfitrión del catálogo en Solo audio: voz y estilo, sin prometer rostro ni avatar", () => {
  const html = renderToStaticMarkup(<HostChosenNote name="Valeria Montclair" modality="audio" tag="A" />);
  assert.match(html, /data-testid="anfitrion-elegido-A"/);
  assert.match(html, /Valeria Montclair: voz y estilo del catálogo/);
  assert.match(html, /solo se oye su voz; no aparece su imagen/);
  assert.doesNotMatch(html, /rostro/);
});

test("modalidades visuales conservan su explicación: rostro, voz y estilo", () => {
  for (const m of ["visual", "avatar", "dialogo"] as const) {
    assert.equal(hostChosenText("Víctor Albarrán", m), "Víctor Albarrán: rostro, voz y estilo del catálogo (personaje virtual de Atomicvid).", m);
  }
  const html = renderToStaticMarkup(<HostChosenNote name="Víctor Albarrán" modality="dialogo" tag="B" />);
  assert.match(html, /data-testid="anfitrion-elegido-B"/);
  assert.match(html, /rostro, voz y estilo del catálogo/);
});

test("el asistente usa estas piezas: la nota aparece al elegir Solo audio y la ficha recibe la modalidad", () => {
  const src = readFileSync(path.join(__dirname, "PodcastWizard.tsx"), "utf8");
  assert.match(src, /\{d\.modality === "audio" && <AudioOnlyNote \/>\}/);
  assert.match(src, /<HostChosenNote name=\{p\.name\} modality=\{d\.modality\} tag=\{tag\(i\)\} \/>/);
  // La ficha ya no está escrita a mano con «rostro» fuera de hostChosenText.
  assert.equal(src.split("rostro, voz y estilo").length - 1, 1);
  // La descripción de la modalidad tampoco promete nada visual.
  assert.match(src, /audio: "Una o dos voces, música opcional y exportación a MP3 o WAV\. Sin video, imágenes ni avatar/);
});
