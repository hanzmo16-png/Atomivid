/**
 * Incidente Bigfoot (7b5c857f): la revisión editorial catalog-v1 terminó en end_turn con JSON
 * válido, pero sections[2].function = "complication", que no es una función del contrato
 * (setup, new_information, consequence, reversal, resolution, restatement). No hay una
 * equivalencia inequívoca: el rechazo se conserva (no se inventa ni se asigna por posición) y
 * el error nombra la ruta exacta, sin valores ni texto del guion.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseDocumentaryResponse, DocumentaryResponseError } from "./json-response";
import { LenientReferencedReviewSchema, ReferencedEditorialReviewSchema } from "./narration-catalog";
import { EditorialReviewSchema } from "./editorial";

/** Forma mínima del incidente: 5 secciones (una por bloque), contrato catalog-v1, sin hallazgos. */
function incidentReview(fn3 = "complication") {
  const ref = (i: number) => ({ excerptId: `r1:b${i}:w0` });
  return {
    sections: ["setup", "new_information", fn3, "reversal", "resolution"].map((f, i) => ({ excerptId: ref(i).excerptId, contribution: "x", function: f })),
    firstAnswer: { delivered: true, evidence: ref(0), explanation: "x" },
    ending: { resolvesPromise: true, evidence: ref(4), explanation: "x" },
    findings: [],
  };
}
const message = (value: unknown) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(value) }] });

test("regresión Bigfoot: 'complication' en sections[2].function se rechaza con la ruta exacta en ambos esquemas", () => {
  for (const schema of [ReferencedEditorialReviewSchema, LenientReferencedReviewSchema]) {
    const r = schema.safeParse(incidentReview());
    assert.equal(r.success, false);
    if (r.success) return;
    assert.deepEqual(r.error.issues.map((i) => [i.code, i.path.join(".")]), [["invalid_value", "sections.2.function"]]);
  }
  assert.throws(
    () => parseDocumentaryResponse(LenientReferencedReviewSchema, message(incidentReview())),
    (e: unknown) => e instanceof DocumentaryResponseError && JSON.stringify(e.issues) === JSON.stringify(["invalid_value@sections.2.function"]),
  );
});

test("control: la misma respuesta con una función del contrato se acepta (el único defecto es esa etiqueta)", () => {
  for (const f of ["setup", "new_information", "consequence", "reversal", "resolution", "restatement"]) {
    assert.equal(parseDocumentaryResponse(LenientReferencedReviewSchema, message(incidentReview(f))).sections[2].function, f);
  }
});

test("valores desconocidos siguen rechazados: sin normalización ni asignación por posición", () => {
  for (const f of ["complication", "Complication", "climax", "rising_action", "escalation", "", "consequence "]) {
    assert.throws(() => parseDocumentaryResponse(LenientReferencedReviewSchema, message(incidentReview(f))), DocumentaryResponseError, JSON.stringify(f));
  }
  // El contrato no cambió: la enumeración aceptada es exactamente la pedida al modelo.
  assert.deepEqual(EditorialReviewSchema.shape.sections.element.shape.function.options, ["setup", "new_information", "consequence", "reversal", "resolution", "restatement"]);
});

test("el diagnóstico nunca expone el valor rechazado ni texto del guion; el mensaje al cliente no cambia", () => {
  try {
    parseDocumentaryResponse(LenientReferencedReviewSchema, message(incidentReview("complication")));
    assert.fail("debía rechazar");
  } catch (e) {
    assert.ok(e instanceof DocumentaryResponseError);
    assert.equal(e.message, "La respuesta no cumple el formato editorial requerido. La respuesta y su consumo quedaron registrados; no se repite la llamada automáticamente.");
    assert.equal(/complication/.test(JSON.stringify(e.issues) + e.message), false);
  }
  const jobs = readFileSync(path.join(__dirname, "script-jobs.ts"), "utf8");
  assert.match(jobs, /error instanceof DocumentaryResponseError && error\.issues\.length/);
});
