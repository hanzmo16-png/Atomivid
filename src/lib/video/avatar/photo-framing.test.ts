/**
 * T-20261101-0219 — clasificación del encuadre de la foto del avatar. Entradas SINTÉTICAS (números), sin fotos reales.
 * Los siete escenarios son los medidos en la auditoría T-20261101-0111 sobre siluetas dibujadas (sin rostro).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPhotoFraming, FRAMING_THRESHOLDS, type FramingMetrics } from "./photo-framing";

const m = (over: Partial<FramingMetrics> = {}): FramingMetrics => ({
  faceDetected: true, faceCut: false, marginLeftFaces: 2.0, marginRightFaces: 2.0, faceHeightRatio: 0.2, shoulderTouchesEdge: false, ...over,
});

test("umbrales publicados (los de la auditoría)", () => {
  assert.deepEqual({ ...FRAMING_THRESHOLDS }, { strongMarginFaces: 1.2, warnMarginFaces: 1.5, maxFaceHeightRatio: 0.5 });
  assert.ok(Object.isFrozen(FRAMING_THRESHOLDS));
});

test("los siete escenarios sintéticos de la auditoría (métricas medidas)", () => {
  const cases: [string, FramingMetrics, string, string[]][] = [
    ["hombros completos, vertical", m({ faceHeightRatio: 0.138, marginLeftFaces: 2.05, marginRightFaces: 2.05 }), "VALID", []],
    ["un borde tocado", m({ faceHeightRatio: 0.138, marginLeftFaces: 1.05, marginRightFaces: 3.05, shoulderTouchesEdge: true }), "STRONG_WARNING", ["TIGHT_MARGIN"]],
    ["ambos bordes, retrato cerrado", m({ faceHeightRatio: 0.28, marginLeftFaces: 1.0, marginRightFaces: 1.0, shoulderTouchesEdge: true }), "STRONG_WARNING", ["TIGHT_MARGIN"]],
    ["primer plano muy cerrado", m({ faceHeightRatio: 0.525, marginLeftFaces: 0.71, marginRightFaces: 0.71, shoulderTouchesEdge: true }), "STRONG_WARNING", ["TIGHT_MARGIN", "FACE_TOO_LARGE"]],
    ["cabeza cortada arriba", m({ faceHeightRatio: 0.188, marginLeftFaces: 1.5, marginRightFaces: 1.5, faceCut: true }), "BLOCK", ["FACE_CUT"]],
    ["horizontal 16:9 centrado", m({ faceHeightRatio: 0.241, marginLeftFaces: 3.69, marginRightFaces: 3.69 }), "VALID", []],
    ["horizontal 16:9 a un lado", m({ faceHeightRatio: 0.241, marginLeftFaces: 1.0, marginRightFaces: 6.38, shoulderTouchesEdge: true }), "STRONG_WARNING", ["TIGHT_MARGIN"]],
  ];
  for (const [name, input, level, reasons] of cases) {
    const r = classifyPhotoFraming(input);
    assert.equal(r.level, level, name); assert.deepEqual(r.reasons, reasons, name);
  }
});

test("calibración numérica de la auditoría: 0,97 caras → aviso fuerte; 1,42 con contacto → aviso", () => {
  assert.equal(classifyPhotoFraming(m({ marginLeftFaces: 0.98, marginRightFaces: 0.97, faceHeightRatio: 0.288, shoulderTouchesEdge: true })).level, "STRONG_WARNING");
  const leve = classifyPhotoFraming(m({ marginLeftFaces: 1.42, marginRightFaces: 1.44, faceHeightRatio: 0.321, shoulderTouchesEdge: true }));
  assert.equal(leve.level, "WARNING"); assert.deepEqual(leve.reasons, ["NARROW_MARGIN_AT_SHOULDER"]); assert.equal(leve.minMarginFaces, 1.42);
});

test("límites exactos: 1,2 y 1,5 caras; 0,5 del alto", () => {
  // 1,2 no es < 1,2: no es aviso fuerte; con contacto es aviso; sin contacto, válido.
  assert.equal(classifyPhotoFraming(m({ marginLeftFaces: 1.2, shoulderTouchesEdge: true })).level, "WARNING");
  assert.equal(classifyPhotoFraming(m({ marginLeftFaces: 1.2, shoulderTouchesEdge: false })).level, "VALID");
  assert.equal(classifyPhotoFraming(m({ marginLeftFaces: 1.1999, shoulderTouchesEdge: false })).level, "STRONG_WARNING", "por debajo de 1,2 no depende del contacto");
  // 1,5 no es < 1,5: válido aunque toque.
  assert.equal(classifyPhotoFraming(m({ marginLeftFaces: 1.5, shoulderTouchesEdge: true })).level, "VALID");
  assert.equal(classifyPhotoFraming(m({ marginLeftFaces: 1.4999, shoulderTouchesEdge: true })).level, "WARNING");
  // 0,5 del alto no es > 0,5.
  assert.equal(classifyPhotoFraming(m({ faceHeightRatio: 0.5 })).level, "VALID");
  assert.deepEqual(classifyPhotoFraming(m({ faceHeightRatio: 0.5001 })).reasons, ["FACE_TOO_LARGE"]);
  // El margen considerado es el MENOR de los dos lados.
  assert.equal(classifyPhotoFraming(m({ marginLeftFaces: 9, marginRightFaces: 1.0 })).minMarginFaces, 1.0);
});

test("precedencia: bloqueo sobre avisos; todas las razones, en orden estable", () => {
  const all = classifyPhotoFraming(m({ faceCut: true, marginLeftFaces: 0.5, marginRightFaces: 0.6, faceHeightRatio: 0.9, shoulderTouchesEdge: true }));
  assert.equal(all.level, "BLOCK"); assert.deepEqual(all.reasons, ["FACE_CUT", "TIGHT_MARGIN", "FACE_TOO_LARGE"]);
  const strongOverWarn = classifyPhotoFraming(m({ marginLeftFaces: 1.3, faceHeightRatio: 0.6, shoulderTouchesEdge: true }));
  assert.equal(strongOverWarn.level, "STRONG_WARNING"); assert.deepEqual(strongOverWarn.reasons, ["FACE_TOO_LARGE", "NARROW_MARGIN_AT_SHOULDER"]);
  // Determinista: misma entrada, mismo resultado.
  assert.deepEqual(classifyPhotoFraming(m({ marginLeftFaces: 1.3, shoulderTouchesEdge: true })), classifyPhotoFraming(m({ marginLeftFaces: 1.3, shoulderTouchesEdge: true })));
});

test("sin cara: aviso fuerte (no bloqueo); con cara cortada declarada, bloqueo", () => {
  const none = classifyPhotoFraming({ faceDetected: false, faceCut: false, marginLeftFaces: null, marginRightFaces: null, faceHeightRatio: null, shoulderTouchesEdge: false });
  assert.equal(none.level, "STRONG_WARNING"); assert.deepEqual(none.reasons, ["NO_FACE"]); assert.equal(none.minMarginFaces, null);
  assert.equal(classifyPhotoFraming({ faceDetected: false, faceCut: true, marginLeftFaces: null, marginRightFaces: null, faceHeightRatio: null, shoulderTouchesEdge: false }).level, "BLOCK");
});

test("entradas inválidas: NaN, infinitos, negativos, fuera de rango, nulos con cara y tipos erróneos → INVALID_METRICS (nunca VALID)", () => {
  const bad: Partial<FramingMetrics>[] = [
    { marginLeftFaces: Number.NaN }, { marginRightFaces: Number.POSITIVE_INFINITY }, { marginLeftFaces: -0.1 },
    { faceHeightRatio: 0 }, { faceHeightRatio: -0.2 }, { faceHeightRatio: 1.01 }, { faceHeightRatio: Number.NaN },
    { marginLeftFaces: null }, { faceHeightRatio: null },
  ];
  for (const b of bad) {
    const r = classifyPhotoFraming(m(b));
    assert.equal(r.level, "STRONG_WARNING", JSON.stringify(b)); assert.deepEqual(r.reasons, ["INVALID_METRICS"], JSON.stringify(b)); assert.equal(r.minMarginFaces, null);
  }
  const wrongTypes = classifyPhotoFraming({ ...m(), faceDetected: "sí" as unknown as boolean });
  assert.equal(wrongTypes.level, "STRONG_WARNING"); assert.ok(wrongTypes.reasons.includes("INVALID_METRICS"));
  assert.equal(classifyPhotoFraming({ ...m(), shoulderTouchesEdge: undefined as unknown as boolean }).reasons.includes("INVALID_METRICS"), true);
  assert.equal(classifyPhotoFraming(null as unknown as FramingMetrics).level, "STRONG_WARNING", "sin métricas no se afirma nada");
  // Un margen 0 es válido como número (la cara toca el borde por el centro): aviso fuerte por margen, no inválido.
  assert.deepEqual(classifyPhotoFraming(m({ marginLeftFaces: 0 })).reasons, ["TIGHT_MARGIN"]);
});

test("la API no lleva texto de interfaz ni datos personales: solo niveles, claves y números", () => {
  const r = classifyPhotoFraming(m({ marginLeftFaces: 1.0, shoulderTouchesEdge: true }));
  assert.deepEqual(Object.keys(r).sort(), ["level", "minMarginFaces", "reasons"]);
  for (const x of r.reasons) assert.match(x, /^[A-Z_]+$/);
});
