/**
 * Regresiones del recorrido de cliente del candidato de lanzamiento (T-20261125-1613). USD 0: sólo render y modelo.
 *  1. Duración: 239,6 s se mostraba «3 min 60 s» (redondeo de los segundos por separado).
 *  2. Biblioteca: la insignia era la del borrador («Listo para autorizar» en verde) aunque el audio estuviera en
 *     curso, interrumpido o fallido, y no mostraba el idioma; con el MP3 listo seguía diciendo «Generar requiere…».
 *  3. Descarga: con tildes o «ñ» en el título el archivo se guardaba como «download» (doble codificación de supabase-js).
 *  4. Editor: si el MP3 no carga (URL firmada caducada, red), el reproductor quedaba mudo sin aviso ni reintento.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AudioLibrary } from "./AudioLibrary";
import { AudioEditor } from "./AudioEditor";
import { applyInput, downloadFileName, formatAudioDuration, IDLE_GENERATION, languageLabel, libraryAudioState, newProject, STALE_MS, type AudioResult, type Generation } from "@/lib/audio-studio/model";
import { view, type ProjectView } from "@/lib/audio-studio/service";

const A = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-11-25T22:00:00.000Z";
const now = Date.parse(NOW);
const AUDIO: AudioResult = {
  path: `videos/audio-studio/${A}/aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1/r1.mp3`, bytes: 3_841_234, sha256: "0".repeat(64), durationSeconds: 239.6, lufs: -16, truePeak: -1.5,
  revision: 1, renderedAt: NOW, provider: "fixture", model: "eleven_v4_turbo", segments: 12, reusedSegments: 0, musicTracks: [],
};
const project = (over: { generation?: Partial<Generation>; audio?: AudioResult | null; language?: "es" | "en"; status?: "borrador" | "listo_para_autorizar" } = {}): ProjectView => {
  const base = applyInput(newProject({ id: "aaaaaaaa-aaaa-4aaa-8aaa-0000000000a1", ownerId: A, now: NOW, title: "Dúo terminado", voiceCount: 2, language: over.language ?? "es" }), {}, NOW);
  return view({ ...base, status: over.status ?? "listo_para_autorizar", revision: 1, audio: over.audio === undefined ? AUDIO : over.audio, generation: { ...IDLE_GENERATION, ...over.generation } }, {});
};
const beat = (ms: number) => new Date(now - ms).toISOString();

test("duración: se redondea el total, nunca «N min 60 s»", () => {
  assert.equal(formatAudioDuration(239.6), "4 min 0 s");
  assert.equal(formatAudioDuration(239.4), "3 min 59 s");
  assert.equal(formatAudioDuration(59.5), "1 min 0 s");
  assert.equal(formatAudioDuration(0), "0 min 0 s");
  assert.equal(formatAudioDuration(Number.NaN), "0 min 0 s");
  for (let s = 0; s < 3600; s += 0.1) assert.doesNotMatch(formatAudioDuration(s), /\b60 s$/, String(s));
});

test("biblioteca y editor muestran la duración bien formada", () => {
  const lib = renderToStaticMarkup(<AudioLibrary projects={[project({ generation: { status: "terminada" } })]} archived={false} now={now} />);
  assert.match(lib, /MP3 · 4 min 0 s/); assert.doesNotMatch(lib, /60 s/);
  const ed = renderToStaticMarkup(<AudioEditor initial={project({ generation: { status: "terminada" } })} synthesis="local" />);
  assert.match(ed, /4 min 0 s · -16 LUFS/); assert.doesNotMatch(ed, /60 s/);
});

test("estado del audio: verde sólo con MP3; en curso sólo con latido; sin latido, interrumpido", () => {
  assert.deepEqual(libraryAudioState({ ...IDLE_GENERATION, status: "terminada" }, true, now).tone, "success");
  assert.equal(libraryAudioState({ ...IDLE_GENERATION, status: "terminada" }, true, now).label, "Audio listo");
  const live = libraryAudioState({ ...IDLE_GENERATION, status: "generando", heartbeatAt: beat(1000), progress: { done: 7, total: 20 } }, false, now);
  assert.deepEqual([live.label, live.tone], ["Generando · 35%", "info"]);
  assert.match(live.hint, /no vuelvas a generarlo/);
  assert.deepEqual([libraryAudioState({ ...IDLE_GENERATION, status: "en_cola", heartbeatAt: beat(1000) }, false, now).label], ["En cola"]);
  const stale = libraryAudioState({ ...IDLE_GENERATION, status: "generando", heartbeatAt: beat(STALE_MS + 1), progress: { done: 7, total: 20 } }, false, now);
  assert.deepEqual([stale.label, stale.tone], ["Interrumpida", "warning"]);
  const failed = libraryAudioState({ ...IDLE_GENERATION, status: "fallida", error: "x" }, false, now);
  assert.deepEqual([failed.label, failed.tone], ["Falló", "danger"]);
  assert.match(libraryAudioState({ ...IDLE_GENERATION, status: "fallida" }, true, now).hint, /MP3 anterior sigue disponible/);
  const idle = libraryAudioState(IDLE_GENERATION, false, now);
  assert.deepEqual([idle.label, idle.tone], ["Sin generar", "neutral"]);
  // Nunca verde sin un MP3 guardado, en ningún estado.
  for (const status of ["inactiva", "en_cola", "generando", "fallida", "terminada"] as const)
    for (const hb of [beat(1000), beat(STALE_MS + 1), null]) assert.notEqual(libraryAudioState({ ...IDLE_GENERATION, status, heartbeatAt: hb }, false, now).tone, "success", `${status} ${hb}`);
});

test("biblioteca: la insignia es la del audio, no un verde falso del borrador", () => {
  const html = (p: ProjectView) => renderToStaticMarkup(<AudioLibrary projects={[p]} archived={false} now={now} />);
  const badge = (s: string) => s.match(/data-testid="audio-library-state">([^<]*)</)?.[1];
  const running = html(project({ audio: null, generation: { status: "generando", heartbeatAt: beat(1000), progress: { done: 3, total: 12 } } }));
  assert.equal(badge(running), "Generando · 25%");
  assert.doesNotMatch(running, /bg-success[^"]*"[^>]*>\s*<span[^>]*data-testid="audio-library-state"/);
  assert.doesNotMatch(running, /Generar requiere tu autorización/);
  assert.equal(badge(html(project({ audio: null, generation: { status: "generando", heartbeatAt: beat(STALE_MS + 5) } }))), "Interrumpida");
  assert.equal(badge(html(project({ audio: null, generation: { status: "fallida", error: "x" } }))), "Falló");
  const ready = html(project({ generation: { status: "terminada" } }));
  assert.equal(badge(ready), "Audio listo");
  assert.doesNotMatch(ready, /Generar requiere/);
  // El estado del borrador sigue visible como texto, sin competir con la insignia.
  assert.match(ready, /gastado USD 0\.00 · Listo para autorizar/);
  assert.match(html(project({ audio: null })), /Sin generar[\s\S]*Generar requiere tu autorización del gasto/);
});

test("biblioteca: muestra el idioma y las dos voces", () => {
  const es = renderToStaticMarkup(<AudioLibrary projects={[project({ generation: { status: "terminada" } })]} archived={false} now={now} />);
  assert.match(es, /Español · 2 voces · [^·]+ y [^·]+ · objetivo/);
  const en = renderToStaticMarkup(<AudioLibrary projects={[project({ language: "en", generation: { status: "terminada" } })]} archived={false} now={now} />);
  assert.match(en, /English · 2 voces/);
  assert.equal(languageLabel("es"), "Español"); assert.equal(languageLabel("en"), "English");
});

test("editor: el reproductor tiene manejo de error (aviso y reintento se montan al fallar la carga)", () => {
  // En render estático no hay evento de error: se comprueba que el aviso NO aparece de entrada y que el reproductor
  // existe; el aviso y el reintento se prueban en el navegador (launch-candidate-e2e.cjs, paso 8).
  const ed = renderToStaticMarkup(<AudioEditor initial={project({ generation: { status: "terminada" } })} synthesis="local" />);
  assert.match(ed, /data-testid="audio-player"/);
  assert.doesNotMatch(ed, /audio-player-error/);
  assert.match(ed, /data-testid="audio-download"/);
});

test("descarga: nombre ASCII con .mp3 que sobrevive a la doble codificación de supabase-js", () => {
  assert.equal(downloadFileName("Conversación en la pestaña 1"), "Conversacion en la pestana 1.mp3");
  assert.equal(downloadFileName("El día que entiendes que no puedes controlarlo todo"), "El dia que entiendes que no puedes controlarlo todo.mp3");
  assert.equal(downloadFileName("¿Qué? ¡Sí! — 2/3"), "Que Si 2 3.mp3");
  assert.equal(downloadFileName("🎙️"), "episodio.mp3");
  assert.equal(downloadFileName("a".repeat(200)), `${"a".repeat(80)}.mp3`);
  // Lo mismo que hace createSignedUrl: URLSearchParams + encodeURI; el servidor decodifica una vez.
  for (const t of ["Conversación pestaña 1", "Ñandú — día", "Hola mundo"]) {
    const q = new URLSearchParams(); q.set("download", downloadFileName(t));
    const got = new URL(encodeURI(`http://x/object/sign/a.mp3?token=t&${q}`)).searchParams.get("download");
    assert.equal(got, downloadFileName(t), t);
    assert.match(got!, /^[A-Za-z0-9 _-]+\.mp3$/);
  }
});

test("biblioteca y editor: el enlace de descarga sugiere el nombre del MP3", () => {
  const p = project({ generation: { status: "terminada" } });
  assert.match(renderToStaticMarkup(<AudioLibrary projects={[p]} archived={false} now={now} />), /download="Duo terminado\.mp3"/);
  assert.match(renderToStaticMarkup(<AudioEditor initial={p} synthesis="local" />), /download="Duo terminado\.mp3"/);
});
