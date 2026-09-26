import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COVER_CANVAS,
  COVER_STYLE_IDS,
  COVER_STYLES,
  VIDEO_CAPTION_ZONE_TOP,
  VIDEO_LABEL_ZONE,
  contrastRatio,
  coverErrors,
  coverWindowSeconds,
  fitCover,
  parseCoverTitle,
  textWidthEm,
  validateCover,
} from "./cover-rules";

const codes = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code);

test("título: mayúsculas y énfasis con *…* (una o varias palabras)", () => {
  assert.deepEqual(parseCoverTitle("Cavar una *montaña*"), [
    { text: "CAVAR", highlight: false },
    { text: "UNA", highlight: false },
    { text: "MONTAÑA", highlight: true },
  ]);
  assert.deepEqual(parseCoverTitle("*el canal* imposible").map((w) => w.highlight), [true, true, false]);
});

test("métrica real de Anton: la I es estrecha, la M ancha, y un título se mide por su contenido", () => {
  assert.ok(textWidthEm("I") < textWidthEm("M"));
  assert.ok(Math.abs(textWidthEm("MONTAÑA") - 3.66) < 0.05);
});

test("portada de video válida: 2 líneas grandes arriba a la derecha, fuera de subtítulos y rótulos", () => {
  const r = validateCover({ style: "impacto", title: "Cavar una *montaña*", kicker: "Canal de Panamá · 1881–1914" }, "video", { labelsTopLeft: true });
  assert.deepEqual(coverErrors(r), []);
  assert.equal(r.layout.lines.length, 2);
  assert.ok(r.layout.titlePx >= 120, `tamaño ${r.layout.titlePx}`);
  assert.ok(r.layout.box.y + r.layout.box.h <= VIDEO_CAPTION_ZONE_TOP);
  assert.ok(r.layout.box.x + r.layout.box.w <= 1920 - COVER_CANVAS.video.margin.x);
});

test("longitud y ajuste: nunca se encoge por debajo del mínimo legible", () => {
  const long = validateCover({ style: "impacto", title: "Una historia larguísima que no cabe en la portada del video" }, "video");
  assert.ok(codes(long).includes("title_too_long"));
  const wide = validateCover({ style: "impacto", title: "Supercalifragilisticoespialidosamente" }, "video");
  assert.ok(codes(wide).includes("does_not_fit"), "una palabra más ancha que la caja no cabe");
  assert.ok(codes(validateCover({ style: "impacto", title: "  " }, "video")).includes("title_empty"));
  assert.ok(codes(validateCover({ style: "impacto", title: "*sin cerrar" }, "video")).includes("highlight_unclosed"));
  assert.ok(codes(validateCover({ style: "impacto", title: "Ok título", kicker: "x".repeat(40) }, "video")).includes("kicker_too_long"));
});

test("convivencia: a la izquierda con rótulos, la portada baja bajo la zona de rótulos y sigue fuera de los subtítulos", () => {
  const r = validateCover({ style: "sobrio", title: "Cavar una montaña", placement: "top-left" }, "video", { labelsTopLeft: true });
  assert.deepEqual(coverErrors(r), []);
  assert.ok(r.layout.box.y >= VIDEO_LABEL_ZONE.y + VIDEO_LABEL_ZONE.h);
  // Peor caso (3 líneas al tamaño máximo + antetítulo, bajo los rótulos): sigue por encima de los subtítulos.
  const tall = validateCover({ style: "impacto", title: "Uno dos tres cuatro cinco seis siete", kicker: "Antetítulo", placement: "top-left" }, "video", { labelsTopLeft: true });
  assert.equal(tall.layout.lines.length, 3);
  assert.ok(!codes(tall).includes("overlaps_captions"), JSON.stringify(tall.layout.box));
});

test("sujeto principal: avisa si la portada lo tapa", () => {
  const r = validateCover({ style: "impacto", title: "Cavar una montaña" }, "video", { subject: { x: 1300, y: 100, w: 300, h: 300 } });
  assert.ok(codes(r).includes("covers_subject"));
  assert.equal(r.issues.find((i) => i.code === "covers_subject")?.severity, "warning");
});

test("miniatura: título corto y grande, fuera de la duración de YouTube", () => {
  const r = validateCover({ style: "impacto", title: "Cavar una *montaña*", kicker: "Canal de Panamá" }, "thumbnail");
  assert.deepEqual(coverErrors(r), []);
  assert.ok(r.layout.titlePx >= COVER_CANVAS.thumbnail.minTitlePx);
  assert.ok(codes(validateCover({ style: "impacto", title: "Un título demasiado largo para miniatura" }, "thumbnail")).includes("title_too_long"));
});

test("contraste de todos los estilos ≥ 4.5:1 (antetítulo, título y énfasis)", () => {
  for (const id of COVER_STYLE_IDS) {
    const s = COVER_STYLES[id];
    assert.ok(contrastRatio(s.kickerFg, s.kickerBg) >= 4.5, `${id} antetítulo`);
    assert.ok(contrastRatio(s.titleColor, s.outlineColor) >= 4.5, `${id} título`);
    const hlBg = s.highlightMode === "plate" ? s.highlightColor : s.outlineColor;
    assert.ok(contrastRatio(s.highlightTextColor, hlBg) >= 4.5, `${id} énfasis`);
  }
  assert.equal(contrastRatio("#FFFFFF", "#000000"), 21);
});

test("la placa de énfasis cuenta en el ancho medido (el estilo alerta no desborda)", () => {
  const plain = fitCover({ style: "impacto", title: "Cavar una *montaña*" }, "video");
  const plate = fitCover({ style: "alerta", title: "Cavar una *montaña*" }, "video");
  assert.ok(plate.box.w >= plain.box.w);
});

test("ventana de la portada: dentro de la primera escena, legible y breve", () => {
  assert.equal(coverWindowSeconds(2.62).untilSeconds, 2.62);
  assert.equal(coverWindowSeconds(1).untilSeconds, 1.5);
  assert.equal(coverWindowSeconds(10).untilSeconds, 3.2);
});

test("tildes y virgulillas altas: solo esas líneas reciben espacio extra arriba", async () => {
  const { lineExtraTopEm } = await import("./cover-rules");
  assert.equal(lineExtraTopEm([{ text: "CAVAR" }, { text: "UNA" }]), 0);
  assert.ok(lineExtraTopEm([{ text: "MONTAÑA" }]) > 0);
  const withTilde = fitCover({ style: "impacto", title: "Cavar una montaña" }, "video");
  const without = fitCover({ style: "impacto", title: "Cavar una montana" }, "video");
  assert.ok(withTilde.box.h > without.box.h);
});
