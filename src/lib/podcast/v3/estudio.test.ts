/** Podcast — estudios compartidos, avance por etapas, duración y subtítulos por palabra (puras, sin red ni ffmpeg). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { progressPct, progressView, stagesFor, stageMessage, STALE_MS } from "./progress";
import { STUDIOS, STUDIO_IDS, cameraFor, legacyStudio, placeInSeat, seatOf, studioDef } from "./studios";
import { episodeSeconds, fitToDuration, targetChars, templateConversation, type Turn } from "./script";
import { durationFit, estimateMinutes } from "./wizard";
import { timedPages } from "./compose";

test("avance: por etapas reales y unidades terminadas; nunca 100 % antes de «ready»; espera, sin información y error", () => {
  const all = stagesFor({ video: true, images: true, avatars: true });
  assert.deepEqual(all, ["preparacion", "voces", "imagenes", "avatares", "montaje", "guardado"]);
  assert.deepEqual(stagesFor({ video: false, images: true, avatars: true }), ["preparacion", "voces", "guardado"], "solo audio: sin imágenes, avatares ni montaje");
  assert.ok(progressPct(all, "voces", 5, 10) < progressPct(all, "voces", 10, 10));
  assert.ok(progressPct(all, "avatares", 0, 13) >= progressPct(all, "imagenes", 20, 20));
  assert.equal(progressPct(all, "guardado", 1, 1), 99, "el 100 % solo lo da el estado «ready»");
  const now = Date.parse("2026-10-28T15:00:00Z");
  assert.equal(progressView({ status: "authorized" }, now).state, "espera");
  const running = progressView({ status: "generating", progress: { stage: "avatares", pct: 52, done: 3, total: 13, updatedAt: "2026-10-28T14:58:00Z" } }, now);
  assert.deepEqual([running.state, running.stageLabel, running.detail, running.pct], ["procesando", "Avatares", "3 de 13", 52]);
  assert.equal(progressView({ status: "generating", progress: null, updated_at: "2026-10-28T14:59:00Z" }, now).stageLabel, "Preparación", "ya arrancó: nunca «En cola»");
  assert.equal(progressView({ status: "generating", progress: { stage: "avatares", pct: 52, updatedAt: new Date(now - STALE_MS - 1).toISOString() } }, now).state, "sin_informacion");
  assert.equal(progressView({ status: "failed", progress: { stage: "montaje", pct: 80 } }, now).state, "error");
  assert.equal(progressView({ status: "ready" }, now).pct, 100);
  assert.equal(progressView({ status: "generating", progress: { stage: "video", pct: 70 } }, now).stage, "montaje", "etapas antiguas del worker");
  assert.equal(stageMessage("voces"), "Estamos dando voz a tu episodio");
});

test("estudios: tres compartidos con asientos a cada lado; escenarios anteriores se leen; A izquierda / B derecha y se invierte", () => {
  assert.deepEqual(STUDIOS.map((s) => s.id), [...STUDIO_IDS]);
  for (const s of STUDIOS) assert.ok(s.seats.A.x < 960 && s.seats.B.x > 960, s.id);
  assert.equal(legacyStudio("biblioteca"), "calido"); assert.equal(legacyStudio("neon"), "moderno"); assert.equal(legacyStudio("minimalista"), "minimalista");
  const st = studioDef("calido");
  assert.equal(seatOf(st, "A", false), st.seats.A); assert.equal(seatOf(st, "A", true), st.seats.B);
  const fr = { w: 1920, h: 1080 };
  const m = { w: 720, h: 1280, face: [180, 200, 360, 360] as [number, number, number, number] };
  const wide = placeInSeat(m, st.seats.A, cameraFor("general", st.seats.A, "izquierda", fr));
  assert.ok(Math.abs(wide.x + (180 + 180) * (wide.w / 720) - st.seats.A.x) < 3, "la cara queda en el asiento");
  const close = cameraFor("primer", st.seats.A, "izquierda", fr);
  const L = placeInSeat(m, st.seats.A, close);
  const faceTop = L.y + 200 * (L.h / 1280), faceH = 360 * (L.h / 1280);
  assert.ok(faceTop - faceH * 0.4 > 0, "la cabeza (con pelo) entra completa en el primer plano");
  assert.ok(faceTop + faceH < fr.h * 0.8, "los subtítulos (abajo) no tapan la cara");
  assert.ok(close.blur > 0 && close.frontBlur > close.blur, "fondo desenfocado y primer término aún más");
});

test("duración: el guion se ajusta a la duración pedida al ritmo real de las voces (sin acelerar la voz)", () => {
  const five = templateConversation({ topic: "los Anunnaki y los sumerios", hostName: "Ana", guestName: "Luis", minutes: 5 });
  const secs = episodeSeconds(five);
  assert.ok(Math.abs(secs / 300 - 1) <= 0.15, `plantilla de 5 min: ${(secs / 60).toFixed(2)} min`);
  assert.equal(new Set(five.map((t) => t.text)).size, five.length, "sin bloques repetidos («Y otra cosa:», «Volviendo a eso:»)");
  assert.ok(targetChars(5) > 3500 && targetChars(5) < 4200, String(targetChars(5)));
  // Un guion largo (como el de 5.044 caracteres que dio 6:19) se recorta quitando turnos del desarrollo, no de la voz.
  const long: Turn[] = Array.from({ length: 30 }, (_, i) => ({ id: `T${i}`, speaker: i % 2 ? "B" : "A", kind: "comentario", text: "x".repeat(190) }));
  const fit = fitToDuration(long, 5);
  assert.ok(fit.trimmed > 0 && episodeSeconds(fit.turns) <= 300 * 1.05, `${fit.trimmed} turnos fuera, ${episodeSeconds(fit.turns).toFixed(0)} s`);
  assert.equal(fit.turns.at(-1)!.text, long.at(-1)!.text, "se conserva el cierre");
  const script = long.map((t) => `${t.speaker === "A" ? "Ana" : "Luis"}: ${t.text}`).join("\n");
  assert.equal(durationFit(script, 5), "largo"); assert.ok(estimateMinutes(script) > 5.75);
});

test("subtítulos: páginas de ≤ 2 líneas que aparecen cuando se dice su primera palabra", () => {
  const words = "Empecemos por lo básico qué es lo primero que alguien debería saber sobre los Anunnaki y los sumerios".split(" ").map((t, i) => ({ text: t, start: i * 0.4, end: i * 0.4 + 0.35 }));
  const pages = timedPages(words, 24, 9);
  assert.ok(pages.length >= 2);
  assert.equal(pages[0].start, 0);
  for (let i = 1; i < pages.length; i++) { assert.equal(pages[i - 1].end, pages[i].start); assert.ok(pages[i].text.split("\n").length <= 2); }
  const firstWordOfPage2 = pages[1].text.split(/\s+/)[0];
  assert.equal(pages[1].start, words.find((w) => w.text === firstWordOfPage2)!.start, "sincronizado con la palabra");
  assert.equal(pages.at(-1)!.end, 9);
});
