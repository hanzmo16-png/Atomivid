import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuotedIntent, realGraphicSpecProvider } from "./real-graphics";
import type { Shot } from "./types";

function makeShot(overrides: Partial<Shot>): Shot {
  return {
    id: "b1-s1",
    beatId: "beat-1",
    startSec: 0,
    endSec: 10,
    durationSec: 10,
    type: "text",
    source: "local",
    assetId: "b1-s1",
    visualIntent: "x",
    motion: "static",
    captionText: "x",
    license: "ver storyboard",
    attribution: "x",
    dedupKey: "x",
    status: "planned",
    validationStatus: "pending",
    ...overrides,
  };
}

test("parseQuotedIntent extrae la cita literal y el contexto tras el guion largo", () => {
  const { body, context } = parseQuotedIntent(
    "'Evaluadas como posiblemente residenciales — no confirmadas' (hedge literal)",
  );
  assert.equal(body, "Evaluadas como posiblemente residenciales — no confirmadas");
  assert.equal(context, "(hedge literal)");
});

test("parseQuotedIntent sin comillas devuelve el texto completo como cuerpo, sin contexto", () => {
  const { body, context } = parseQuotedIntent("Cifra: >5.5 metros de altura, piedra caliza en bloque único");
  assert.equal(body, "Cifra: >5.5 metros de altura, piedra caliza en bloque único");
  assert.equal(context, undefined);
});

test("realGraphicSpecProvider para type=text produce isFixture:false con la cita real, no un placeholder", () => {
  const shot = makeShot({
    type: "text",
    captionText: "'No sabemos cuántas personas participaron' — texto de honestidad epistémica",
    license: "ver storyboard",
  });
  const spec = realGraphicSpecProvider(shot);
  assert.ok(spec && spec.kind === "text");
  if (spec?.kind === "text") {
    assert.equal(spec.isFixture, false);
    assert.equal(spec.body, "No sabemos cuántas personas participaron");
    assert.equal(spec.title, "texto de honestidad epistémica");
    assert.equal(spec.citation, undefined);
  }
});

test("realGraphicSpecProvider para type=text incluye citation cuando shot.license trae una fuente real", () => {
  const shot = makeShot({
    type: "text",
    captionText: "Rótulo: temporada de excavación 2026",
    license: "karul-2026-excavation-news-aggregate",
  });
  const spec = realGraphicSpecProvider(shot);
  assert.ok(spec?.kind === "text");
  if (spec?.kind === "text") {
    assert.equal(spec.citation, "karul-2026-excavation-news-aggregate");
  }
});

test("realGraphicSpecProvider para type=diagram con patrón '->' construye una cadena de nodos secuenciales real", () => {
  const shot = makeShot({
    type: "diagram",
    captionText: "Cadena logística: extracción -> transporte -> talla -> erección -> repetición",
  });
  const spec = realGraphicSpecProvider(shot);
  assert.ok(spec?.kind === "diagram");
  if (spec?.kind === "diagram") {
    assert.equal(spec.isFixture, false);
    assert.equal(spec.title, "Cadena logística");
    assert.equal(spec.nodes.length, 5);
    assert.equal(spec.nodes[0].label, "extracción");
    assert.equal(spec.nodes[4].label, "repetición");
    assert.equal(spec.edges.length, 4);
  }
});

test("realGraphicSpecProvider para type=diagram sin patrón '->' produce un nodo único con el texto real (no fixture)", () => {
  const shot = makeShot({ type: "diagram", captionText: "Pilar en T, plano medio" });
  const spec = realGraphicSpecProvider(shot);
  assert.ok(spec?.kind === "diagram");
  if (spec?.kind === "diagram") {
    assert.equal(spec.isFixture, false);
    assert.equal(spec.nodes.length, 1);
    assert.equal(spec.nodes[0].label, "Pilar en T, plano medio");
  }
});

test("realGraphicSpecProvider para type=map con shotId conocido (b2-s1) usa la coordenada verificada real", () => {
  const shot = makeShot({ id: "b2-s1", type: "map", captionText: "Ubicar Göbekli Tepe" });
  const spec = realGraphicSpecProvider(shot);
  assert.ok(spec?.kind === "map");
  if (spec?.kind === "map") {
    assert.equal(spec.isFixture, false);
    assert.equal(spec.markers.length, 1);
    assert.equal(spec.markers[0].latitude, 37.22);
    assert.equal(spec.markers[0].longitude, 38.92);
  }
});

test("realGraphicSpecProvider para type=map con shotId desconocido lanza — nunca inventa una coordenada", () => {
  const shot = makeShot({ id: "b99-s1", type: "map", captionText: "Mapa sin coordenada registrada" });
  assert.throws(() => realGraphicSpecProvider(shot), /no tiene coordenadas verificadas registradas/);
});

test("realGraphicSpecProvider devuelve undefined para tipos de shot no gráficos", () => {
  const shot = makeShot({ type: "stock_video" });
  assert.equal(realGraphicSpecProvider(shot), undefined);
});
