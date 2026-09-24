import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Verificación ESTÁTICA (lectura de código fuente, sin ejecutar nada) de
 * que la composición Long Form (16:9) sigue siendo independiente del
 * pipeline Shorts (VerticalReel, 9:16) — ver el comentario de cabecera de
 * remotion/LongFormDoc.tsx y src/lib/video/long-form/render.ts, que
 * declaran esto explícitamente. Si algún día se agrega un import cruzado
 * por accidente, este test lo atrapa antes de que llegue a producción.
 */

const FORBIDDEN_IMPORT_PATTERNS = [/from ["']\.\/VerticalReel["']/, /from ["'].*generate-video["']/];

function assertNoForbiddenImports(filePath: string) {
  const source = readFileSync(filePath, "utf8");
  for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
    assert.doesNotMatch(source, pattern, `${filePath} no debe importar de VerticalReel.tsx ni generate-video.ts`);
  }
}

test("remotion/LongFormDoc.tsx no importa de VerticalReel.tsx ni de generate-video.ts", () => {
  assertNoForbiddenImports(join(process.cwd(), "remotion", "LongFormDoc.tsx"));
});

test("src/lib/video/long-form/render.ts no importa de VerticalReel.tsx ni de generate-video.ts", () => {
  assertNoForbiddenImports(join(process.cwd(), "src", "lib", "video", "long-form", "render.ts"));
});

test("remotion/Root.tsx registra AMBAS composiciones (VerticalReel y LongFormDoc) sin que una dependa de la otra", () => {
  const source = readFileSync(join(process.cwd(), "remotion", "Root.tsx"), "utf8");
  assert.match(source, /id="VerticalReel"/);
  assert.match(source, /id="LongFormDoc"/);
});
