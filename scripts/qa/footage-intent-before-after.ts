/**
 * Antes/después OFFLINE del selector de footage (USD 0, sin red) sobre el catálogo sintético.
 * «Antes» = el selector de la base 4bee0d3 (OLD_SELECTOR=ruta a esa versión); «después» = este código con narración.
 *   git show 4bee0d3:src/lib/video/footage-select.ts > /tmp/oldsel/footage-select.ts (+ footage-score.ts, rutas absolutas)
 *   OLD_SELECTOR=/tmp/oldsel/footage-select.ts node --import tsx scripts/qa/footage-intent-before-after.ts > out.json
 */
import { createFootageSelectionState, selectFootageForScene } from "../../src/lib/video/footage-select";
import { fixtureFootageProvider, FIXTURE_RESULTS, SAMPLE_SCENES } from "../../src/lib/video/footage-intent.fixture";
import { sceneVisualIntent } from "../../src/lib/video/scene-visual-intent";

const desc = (id: string) => Object.values(FIXTURE_RESULTS).flat().find((c) => c.sourceId === id)?.description ?? "";
async function run() {
  const old = process.env.OLD_SELECTOR ? await import(process.env.OLD_SELECTOR) as { selectFootageForScene: typeof selectFootageForScene; createFootageSelectionState: typeof createFootageSelectionState } : null;
  if (!old) throw new Error("OLD_SELECTOR requerido para el «antes» real");
  const rows = [];
  for (const s of SAMPLE_SCENES) {
    const pick = async (narration?: string) => {
      const provider = fixtureFootageProvider();
      const o = narration === undefined
        ? await old.selectFootageForScene({ provider, concepts: s.concepts, minimumDurationSeconds: 3, state: old.createFootageSelectionState() })
        : await selectFootageForScene({ provider, concepts: s.concepts, minimumDurationSeconds: 3, state: createFootageSelectionState(), narration });
      return { sourceId: o.sourceId, description: desc(o.sourceId), query: o.queryUsed, metadataMatch: o.metadataMatch ?? "(no existía)", facets: o.metadataFacets ?? [], searches: provider.calls.length };
    };
    rows.push({ scene: s.id, narration: s.text, concepts: s.concepts, intent: sceneVisualIntent(s.text, s.concepts)?.label ?? null, before: await pick(undefined), after: await pick(s.text) });
  }
  process.stdout.write(JSON.stringify({ source: "OFFLINE FIXTURE — no es una búsqueda real de Pexels", rows }, null, 2));
}
run();
