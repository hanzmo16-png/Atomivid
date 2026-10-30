/** Podcast — estudios compartidos, avance por etapas, duración y subtítulos por palabra (puras, sin red ni ffmpeg). */
import { test } from "node:test";
import data from "./studios.json";
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
  assert.ok(close.blur > 0 && close.frontBlur < close.blur, "fondo desenfocado; mesa y micrófono (a la distancia de quien habla) casi nítidos");
  // 16:9, plano general = plano de conjunto (prueba real 51883d1c: con el estudio entero cada cara medía ~1/10 del alto).
  const W = cameraFor("general", st.seats.A, "izquierda", fr, [st.seats.A.x, st.seats.B.x]);
  assert.ok(st.seats.A.faceH * W.zoom >= fr.h * 0.12, `caras visibles en el plano general (${(st.seats.A.faceH * W.zoom).toFixed(0)} px)`);
  for (const seat of [st.seats.A, st.seats.B]) { const P = placeInSeat(m, seat, W), cx = P.x + 360 * (P.w / 720); assert.ok(cx > fr.w * 0.1 && cx < fr.w * 0.9, "los dos dentro del plano general"); }
  // 9:16, plano general: la franja abarca los dos asientos (más grandes que con el estudio entero) y ninguno se sale.
  const v = { w: 1080, h: 1920 }, span: [number, number] = [st.seats.A.x, st.seats.B.x];
  const vcam = cameraFor("general", st.seats.A, "izquierda", v, span);
  assert.ok(vcam.zoom > (v.w / 1920) * 1.3, `la franja vertical acerca a los dos (zoom ${vcam.zoom.toFixed(3)})`);
  for (const seat of [st.seats.A, st.seats.B]) {
    const P = placeInSeat(m, seat, vcam), cx = P.x + 360 * (P.w / 720);
    assert.ok(cx > 0 && cx < v.w, `las dos caras dentro del cuadro vertical (${cx})`);
  }
  const vc = placeInSeat(m, st.seats.B, cameraFor("primer", st.seats.B, "derecha", v, span));
  const vTop = vc.y + 200 * (vc.h / 1280), vFace = 360 * (vc.h / 1280);
  assert.ok(vTop - vFace * 0.4 > 0 && vTop + vFace < v.h * 0.8, "9:16, primer plano: cabeza completa y por encima de los subtítulos");
});

test("estudios premium: un micrófono por asiento apoyado en la mesa, junto a quien habla; sin micrófonos de atrezo en el centro", () => {
  for (const s of data.studios as unknown as { id: string; props?: unknown[]; mics: { base_y: number; offset: number; scale: number }; seats: Record<"A" | "B", { x: number; face: number; faceH: number }>; desk?: { top: number; depth: number } }[]) {
    assert.ok(!s.props?.length, `${s.id}: sin micrófonos sueltos en el centro de la mesa`);
    assert.ok(s.mics.offset > 0.5 && s.mics.offset < 1.2, `${s.id}: micrófono al lado interior de cada cara, sin taparla`);
    if (s.desk) assert.ok(s.mics.base_y >= s.desk.top && s.mics.base_y <= s.desk.top + s.desk.depth, `${s.id}: la base apoya en la cubierta de la mesa`);
    for (const k of ["A", "B"] as const) {
      const seat = s.seats[k];
      // Personas sentadas a la mesa (no hundidas tras ella): la cubierta queda ~2–3 caras por debajo del centro de la cara.
      const below = (s.mics.base_y - seat.face) / seat.faceH;
      assert.ok(below > 2 && below < 3.6, `${s.id} ${k}: mesa a la altura de la cintura (${below.toFixed(2)} caras)`);
    }
  }
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

test("director local: describe cada turno con su contenido y el tema, marca las escenas del pasado como recreación, sin costo", async () => {
  const { localDirector } = await import("./adapters");
  const d = localDirector({ dir: "/tmp" });
  const r = await d.brief({ topic: "Anunnaki, sumerios y tablillas cuneiformes", title: "T", language: "es", turns: [
    { id: "T001", text: "Las tablillas cuneiformes de Nippur cuentan cómo los dioses sumerios repartieron el cielo y la tierra." },
    { id: "T002", text: "¿Y qué opinas de quienes dicen que eran visitantes de otro planeta?" }] });
  assert.equal(r.actualUsd, 0); assert.equal(d.briefUsd + d.verifyUsd, 0);
  assert.equal(r.briefs.length, 2);
  assert.match(r.briefs[0].prompt, /tablillas cuneiformes de Nippur/); assert.match(r.briefs[0].prompt, /Anunnaki/);
  assert.equal(r.briefs[0].recreation, true, "una escena histórica se etiqueta «Recreación»");
  assert.match(r.briefs[1].subject, /^Anunnaki, sumerios y tablillas cuneiformes:/, "lo que debe verse incluye el tema");
});

test("Recraft: autorización duradera (proyecto + autorización + transacción) antes de llamar; sin comprobante válido no hay llamada", async () => {
  const { ticketRefusal, realRecraftImages } = await import("./adapters");
  const at = "2026-10-28T18:00:00.000Z";
  const t = { projectId: "ep1", ownerId: "u1", provider: "recraft", authorizationRef: at, transactionId: "k1" };
  const ok = { op: { key: "k1", episode_id: "ep1", user_id: "u1", provider: "recraft", state: "reserved" }, episode: { id: "ep1", user_id: "u1", status: "generating", authorized_usd: 5, authorized_at: "2026-10-28T18:00:00+00:00" } };
  assert.equal(ticketRefusal(t, ok), null, "reserva abierta del episodio autorizado: se permite");
  const bad: [string, Parameters<typeof ticketRefusal>[0], Parameters<typeof ticketRefusal>[1]][] = [
    ["sin comprobante", undefined, ok],
    ["sin autorización duradera", { ...t, authorizationRef: null }, ok],
    ["transacción inexistente", t, { ...ok, op: null }],
    ["otra transacción", { ...t, transactionId: "k2" }, ok],
    ["reserva ya liquidada", t, { ...ok, op: { ...ok.op, state: "settled" } }],
    ["reserva de otro episodio", t, { ...ok, op: { ...ok.op, episode_id: "ep2" } }],
    ["reserva de otro dueño", t, { ...ok, op: { ...ok.op, user_id: "u2" } }],
    ["reserva de otro proveedor", t, { ...ok, op: { ...ok.op, provider: "elevenlabs" } }],
    ["episodio de otro dueño", t, { ...ok, episode: { ...ok.episode, user_id: "u2" } }],
    ["episodio en borrador", t, { ...ok, episode: { ...ok.episode, status: "draft" } }],
    ["episodio fallido", t, { ...ok, episode: { ...ok.episode, status: "failed" } }],
    ["sin importe autorizado", t, { ...ok, episode: { ...ok.episode, authorized_usd: null } }],
    ["autorización reemplazada", t, { ...ok, episode: { ...ok.episode, authorized_at: "2026-10-28T19:00:00Z" } }],
  ];
  for (const [why, tk, f] of bad) assert.ok(ticketRefusal(tk, f), `debe rechazar: ${why}`);
  // El adaptador real rechaza ANTES de la credencial y de la red: con FAL_KEY puesta, no llega a fal.
  const prevKey = process.env.FAL_KEY; process.env.FAL_KEY = "clave-de-prueba";
  let reads = 0;
  const rc = realRecraftImages({ styleRefs: async () => { throw new Error("no debe pedir referencias"); }, readTicket: async () => { reads++; return { ...ok, op: { ...ok.op, state: "settled" } }; } });
  const req = { prompt: "x", negative: "", aspect: "16:9" as const, attempt: 1 };
  try {
    await assert.rejects(rc.generate!(req, "/tmp/no-se-escribe.png"), (e: Error) => e.name === "ProviderRejectedError" && /sin comprobante/.test(e.message));
    assert.equal(reads, 0, "sin comprobante ni siquiera se consulta la base");
    await assert.rejects(rc.generate!(req, "/tmp/no-se-escribe.png", t), (e: Error) => e.name === "ProviderRejectedError" && /no está abierta/.test(e.message));
    assert.equal(reads, 1);
  } finally { if (prevKey === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = prevKey; }
});

test("texto en pantalla: subtítulos, tarjeta y título caben en el ancho del cuadro (16:9 y 9:16)", async () => {
  const { lineChars, textLines } = await import("./compose");
  const long = "Volviendo a eso: Pasemos a la historia. ¿Cuál fue el momento que cambió la forma en que entendemos Los Anunnaki y los sumerios?";
  for (const [w, h] of [[1920, 1080], [1080, 1920]]) {
    const fs = Math.round(h * (w > h ? 0.04 : 0.028));
    for (const k of [1, 1.3, 1.6]) {
      const size = Math.round(fs * k), n = lineChars(w, h, size, fs);
      // DejaVu Sans Bold: ~0,6 em por carácter de media en texto en español.
      for (const line of textLines(long, n)) assert.ok(line.length * 0.6 * size <= w * 0.97, `${w}x${h} ×${k}: «${line}» (${line.length} car.) cabe`);
    }
  }
});
