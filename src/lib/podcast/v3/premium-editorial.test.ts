/**
 * Podcast — dirección visual Premium 4.0 (episodio real 51883d1c «Vida después de la visa»: 27 ilustraciones casi
 * iguales de ruinas y arcos). Sin red ni proveedores.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SHOT_VARIETY, topicEra } from "./editorial";
import { recraftInput } from "@/lib/providers/image/recraft";
import { templateConversation } from "./script";

const VISA = "Vida después de la visa";

test("época del episodio: un tema de actualidad no se ilustra como documental histórico", () => {
  const turns = templateConversation({ topic: VISA, hostName: "Hans", guestName: "Valeria", minutes: 5 }).map((t) => t.text);
  assert.equal(topicEra(VISA, turns), "actual");
  assert.equal(topicEra("Los sumerios y la escritura cuneiforme", []), "historica");
  assert.equal(topicEra("Una ciudad", ["El imperio romano la fundó.", "Hoy es moderna.", "Tiene metro."]), "historica", "un tercio de turnos del pasado basta");
});

test("director local: escenas del presente, un encuadre distinto en cada turno y nada marcado «Recreación»", async () => {
  const { localDirector } = await import("./adapters");
  const turns = Array.from({ length: 10 }, (_, i) => ({ id: `T${String(i + 1).padStart(3, "0")}`, text: `Turno ${i + 1}: hablamos de cómo cambia la vida al llegar a otro país con una visa nueva.` }));
  const r = await localDirector({ dir: "/tmp" }).brief({ topic: VISA, title: VISA, language: "es", turns });
  assert.ok(r.briefs.every((b) => b.era === "actual" && !b.recreation && /present-day/.test(b.prompt)), r.briefs[0].prompt);
  const shots = r.briefs.map((b) => SHOT_VARIETY.find((s) => b.prompt.includes(s)));
  assert.ok(shots.every(Boolean), "cada turno lleva un encuadre");
  for (let i = 1; i < shots.length; i++) assert.notEqual(shots[i], shots[i - 1], "dos ilustraciones seguidas no comparten composición");
  assert.equal(new Set(shots).size, SHOT_VARIETY.length, "10 turnos recorren los 8 encuadres");
});

test("Recraft: en temas de actualidad las referencias de estilo se aplican en modo flexible (luz y color, no contenido)", () => {
  const input = recraftInput({ prompt: "x", aspectRatio: "16:9", style: { referenceImageUrls: ["https://x/estilo-1.jpg"], match: "flexible" } } as never);
  assert.equal(input.style_match, "flexible");
  assert.equal(recraftInput({ prompt: "x", aspectRatio: "16:9", style: { styleId: "a1b2c3d4-0000-4000-8000-000000000000" } } as never).style_match, undefined, "historia: sin cambios");
});
