import { test } from "node:test";
import assert from "node:assert/strict";
import { canRestore, capturePlayback, clampTime, formatPosition, mediaKey, restorePlayback, type MediaLike } from "./player-continuity";

function media(o: Partial<MediaLike> & { playRejects?: boolean } = {}): MediaLike & { plays: number } {
  const m = {
    currentTime: 0, playbackRate: 1, paused: true, ended: false, volume: 1, muted: false, duration: 600, plays: 0,
    play() {
      m.plays += 1;
      if (o.playRejects) return Promise.reject(Object.assign(new Error("play() not allowed"), { name: "NotAllowedError" }));
      m.paused = false;
      return Promise.resolve();
    },
    ...o,
  };
  return m;
}

const A1 = "https://x.supabase.co/storage/v1/object/sign/videos/req-a/output/final.mp4?token=t1";
const A2 = "https://x.supabase.co/storage/v1/object/sign/videos/req-a/output/final.mp4?token=t2";
const B = "https://x.supabase.co/storage/v1/object/sign/videos/req-b/output/final.mp4?token=t1";

test("la clave ignora el token: el mismo objeto renovado conserva identidad", () => {
  assert.equal(mediaKey("req-a", A1), mediaKey("req-a", A2));
  assert.notEqual(mediaKey("req-a", A1), mediaKey("req-b", B));
  assert.notEqual(mediaKey("req-a", A1), mediaKey("req-b", A1), "otra solicitud (otra cuenta) nunca comparte clave");
  assert.equal(mediaKey("req-a", null), null);
  assert.equal(mediaKey("", A1), null);
});

test("solo se restaura sobre el mismo video y solicitud", () => {
  const snap = capturePlayback(media({ currentTime: 125, playbackRate: 1.5, paused: false }), mediaKey("req-a", A1)!);
  assert.ok(canRestore(snap, mediaKey("req-a", A2)));
  assert.ok(!canRestore(snap, mediaKey("req-b", B)));
  assert.ok(!canRestore(snap, null));
  assert.ok(!canRestore(null, mediaKey("req-a", A2)));
});

test("reproduciendo: posición, velocidad, volumen y reproducción restaurados", async () => {
  const snap = capturePlayback(media({ currentTime: 125.4, playbackRate: 1.5, paused: false, volume: 0.4, muted: true }), "k");
  const el = media();
  assert.equal(await restorePlayback(el, snap), "resumed");
  assert.deepEqual([el.currentTime, el.playbackRate, el.volume, el.muted, el.paused, el.plays], [125.4, 1.5, 0.4, true, false, 1]);
});

test("en pausa: se restaura la posición y queda en pausa, sin llamar play()", async () => {
  const el = media();
  assert.equal(await restorePlayback(el, capturePlayback(media({ currentTime: 42, playbackRate: 2 }), "k")), "paused");
  assert.deepEqual([el.currentTime, el.playbackRate, el.paused, el.plays], [42, 2, true, 0]);
});

test("el navegador bloquea play(): queda en pausa en la posición guardada (bloqueado, no error)", async () => {
  const el = media({ playRejects: true });
  assert.equal(await restorePlayback(el, capturePlayback(media({ currentTime: 90, paused: false }), "k")), "blocked");
  assert.deepEqual([el.currentTime, el.paused, el.plays], [90, true, 1]);
});

test("terminado: queda al final y en pausa; nunca reinicia desde 0", async () => {
  const el = media({ duration: 300 });
  assert.equal(await restorePlayback(el, capturePlayback(media({ currentTime: 300, ended: true, paused: true }), "k")), "paused");
  assert.equal(el.currentTime, 300);
});

test("posición acotada a la duración del medio nuevo y valores inválidos neutralizados", () => {
  assert.equal(clampTime(500, 300), 299.75);
  assert.equal(clampTime(-3, 300), 0);
  assert.equal(clampTime(Number.NaN, 300), 0);
  assert.equal(clampTime(50, Number.NaN), 50);
  const s = capturePlayback(media({ currentTime: Number.NaN, playbackRate: 0, volume: 7 }), "k");
  assert.deepEqual([s.time, s.rate, s.volume], [0, 1, 1]);
});

test("formato de posición", () => {
  assert.equal(formatPosition(65), "1:05");
  assert.equal(formatPosition(3727), "1:02:07");
  assert.equal(formatPosition(0), "0:00");
});
