// Reproducción con DATOS REALES persistidos (SELECT): borrador + revisión RESUELTA guardados en editorial_checkpoint de
// dbc89879 (EN 7 min) y 290de42b (ES 5 min), y borrador de e8048599. Las respuestas CRUDAS del proveedor están en Storage
// y no son legibles sin credenciales de servicio (no usadas). Ninguna llamada de red: cualquier `send` falla la prueba.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { editorialBlockers, validateEditorialReview, type EditorialReport } from "./editorial";
import { creativeDirectionIssues, anchorCreativeDirectionSpans } from "./creative-direction";
import { generateDocumentaryScript } from "./documentary-script";

const load = (f: string) => JSON.parse(readFileSync(new URL(`./__fixtures__/${f}`, import.meta.url), "utf8"));
for (const job of ["dbc89879", "290de42b"]) {
  const d = load(`job-${job}-checkpoint.json`);
  test(`REAL ${job}: la revisión guardada es válida, sin bloqueos y sin problemas locales en esta rama`, () => {
    const review = validateEditorialReview(d.review, d.script);
    assert.deepEqual(editorialBlockers(review), []);
    assert.deepEqual(creativeDirectionIssues(anchorCreativeDirectionSpans(d.script.creativeDirection, d.script.beats), d.script.beats, d.creativeHistory), []);
  });
  test(`REAL ${job}: el pipeline aprueba con el borrador y la revisión guardados, 0 llamadas nuevas`, async () => {
    let report: EditorialReport | undefined;
    await generateDocumentaryScript({ researchPack: { topic: "t", sources: d.sourceIds.map((id: string) => ({ id, title: id, kind: "secondary" as const })), openQuestions: [] },
      mode: "curiosity_documentary", language: d.language, targetDurationSeconds: Number(d.durationMinutes) * 60, referenceContract: "catalog-v1", creativeHistory: d.creativeHistory,
      parse: async () => structuredClone(d.script), review: async () => structuredClone(d.review), send: async () => { throw new Error("PAID_CALL_ATTEMPTED"); },
      onEditorialApproved: r => { report = r; } });
    assert.ok(report); assert.equal(report!.corrected, false);
  });
}
