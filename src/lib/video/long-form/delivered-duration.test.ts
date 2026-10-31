import { test } from "node:test";
import assert from "node:assert/strict";
import { outputStatePath } from "./output-finalize";
import {
  deliveredDurationSeconds,
  longFormDurationLabel,
  measuredDurationNote,
  outputStateObjectPath,
  readLongFormDeliveryFacts,
  type DeliveryStorage,
} from "./delivered-duration";

test("la duración medida sale del estado de salida, no de la duración pedida", () => {
  assert.equal(deliveredDurationSeconds({ delivered: { durationSeconds: 272.085 }, rendered: { durationSeconds: 272.1 } }), 272.085);
  assert.equal(deliveredDurationSeconds({ rendered: { durationSeconds: 12 } }), 12);
  assert.equal(deliveredDurationSeconds({ delivered: { durationSeconds: 0 } }), null);
  assert.equal(deliveredDurationSeconds({}), null);
  assert.equal(deliveredDurationSeconds(null), null);
  assert.equal(outputStateObjectPath("req-1"), outputStatePath("req-1"));
});

test("la ficha dice la duración del archivo cuando no es la pedida, y no inventa una si falta", () => {
  assert.equal(longFormDurationLabel(300, 272.085), "4 min 32 s (pedido 5 min)");
  assert.equal(longFormDurationLabel(300, 300.4), "300s");
  assert.equal(longFormDurationLabel(300, null), "300s");
  assert.equal(longFormDurationLabel(90, 40), "40s (pedido 90s)");
  assert.equal(measuredDurationNote(300, 272.085), "Duración del archivo: 4 min 32 s (pedido 5 min)");
  assert.equal(measuredDurationNote(300, 300.4), null);
  assert.equal(measuredDurationNote(300, null), null);
});

test("la lectura del dueño toma la medición y el SRT si existen, y sigue si Storage falla", async () => {
  const storage: DeliveryStorage = {
    async download() {
      return { data: { text: async () => JSON.stringify({ delivered: { durationSeconds: 272.085 } }) }, error: null };
    },
    async list() {
      return { data: [{ name: "final.mp4" }, { name: "subtitles.es.srt" }], error: null };
    },
  };
  const facts = await readLongFormDeliveryFacts(storage, { id: "req-1", language: "es" });
  assert.equal(facts.deliveredDurationSeconds, 272.085);
  assert.equal(facts.subtitlePath, "req-1/output/subtitles.es.srt");

  const down: DeliveryStorage = {
    async download() { throw new Error("storage down"); },
    async list() { throw new Error("storage down"); },
  };
  const missing = await readLongFormDeliveryFacts(down, { id: "req-1", language: "en" });
  assert.equal(missing.deliveredDurationSeconds, null);
  assert.equal(missing.subtitlePath, null);
});
