import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { PreProduceClarity } from "@/components/video/PreProduceClarity";
import { clarityCeiling, preProduceClarity } from "./pre-produce-clarity";

const plan = {
  topic: "El Canal de Panamá",
  publicationTitle: "Cavando una montaña",
  requestedDurationSeconds: 600,
  durationSeconds: 580,
  stockVideoCount: 8,
  stockImageCount: 4,
  aiImageCount: 6,
  aiVideoClipCount: 2,
  deterministicCount: 3,
  estimatedProviderCostUsd: 4.5,
  preflight: { limitUsd: 12, authorization: { authorizedCeilingUsd: 9.4 } },
};

test("la ficha junta video, duración pedida y estimada, recursos y el techo que ya autorizaría la comprobación", () => {
  const fact = preProduceClarity(plan);
  assert.equal(fact.video, "Cavando una montaña");
  assert.equal(fact.topicLine, "El Canal de Panamá");
  assert.equal(fact.duration, "pedida 10 min 00 s · estimada ~9 min 40 s");
  assert.equal(fact.durationNote, null);
  assert.equal(fact.visuals, "12 recursos de archivo · 6 imágenes IA · 2 clips de video IA · 3 tarjetas de texto");
  const one = preProduceClarity({ ...plan, stockVideoCount: 1, stockImageCount: 0, aiImageCount: 1, aiVideoClipCount: 1, deterministicCount: 1 });
  assert.equal(one.visuals, "1 recurso de archivo · 1 imagen IA · 1 clip de video IA · 1 tarjeta de texto");
  assert.deepEqual(fact.ceiling, { label: "Techo que se autorizaría", amount: 9.4 });
});

test("sin título distinto usa el tema; si el techo no cabe lo dice; si no hay autorización usa el límite ya mostrado", () => {
  const same = preProduceClarity({ ...plan, publicationTitle: "  El Canal de Panamá  " });
  assert.equal(same.video, "El Canal de Panamá");
  assert.equal(same.topicLine, null);
  assert.deepEqual(clarityCeiling({ ...plan, preflight: { limitUsd: 12, authorization: { authorizedCeilingUsd: null } } }), {
    label: "Techo que se autorizaría",
    unavailable: "no cabe",
  });
  assert.deepEqual(clarityCeiling({ estimatedProviderCostUsd: 4.5, preflight: { limitUsd: 12, authorization: null } }), {
    label: "Límite autorizado por producción",
    amount: 12,
  });
  assert.deepEqual(clarityCeiling({ estimatedProviderCostUsd: 4.5, preflight: null }), {
    label: "Costo estimado de producción",
    amount: 4.5,
  });
});

test("cuando la estimación se aleja de lo pedido, la ficha lo dice junto al botón", () => {
  const far = preProduceClarity({ ...plan, requestedDurationSeconds: 180, durationSeconds: 300 });
  assert.match(far.duration, /pedida 3 min 00 s · estimada ~5 min 00 s/);
  assert.match(far.durationNote ?? "", /duración estimada/);
  const html = renderToStaticMarkup(<PreProduceClarity input={{ ...plan, originals: true, requestedDurationSeconds: 180, durationSeconds: 300 }} />);
  assert.match(html, /Antes de generar/);
  assert.match(html, /Cavando una montaña/);
  assert.match(html, /El Canal de Panamá/);
  assert.match(html, /imágenes originales/);
  assert.match(html, /Techo que se autorizaría/);
  assert.match(html, /data-testid="pre-produce-clarity"/);
});
