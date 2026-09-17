import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Prueba estructural (lee el código fuente, no lo ejecuta) que confirma
 * que ningún adaptador generativo nuevo (OpenAI/Runway/Beatoven) imprime
 * la API key, el header Authorization, ni una URL de resultado con token
 * (firmada) en ningún console.log/warn/error — ver el comentario explícito
 * en runway.ts sobre por qué esto importa (nunca loguear taskId junto a
 * su URL firmada de resultado).
 */
const FILES = [
  "image/openai.ts",
  "video-gen/runway.ts",
  "music/beatoven.ts",
];

const DANGEROUS_TOKENS = [
  "apiKey",
  "getApiKey()",
  "Authorization",
  "trackUrl",
  "outputUrl",
  "signedUrl",
];

function consoleCallLines(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => /console\.(log|warn|error)\(/.test(line));
}

for (const file of FILES) {
  test(`${file} no imprime credenciales ni URLs firmadas en ningún console.*`, () => {
    const source = readFileSync(path.join(__dirname, file), "utf8");
    const lines = consoleCallLines(source);
    for (const line of lines) {
      for (const token of DANGEROUS_TOKENS) {
        assert.ok(
          !line.includes(token),
          `${file} tiene un console.* que incluye "${token}": ${line.trim()}`,
        );
      }
    }
  });
}

test("ningún adaptador generativo nuevo tiene una API key hardcodeada (string literal larga tipo secreto)", () => {
  for (const file of FILES) {
    const source = readFileSync(path.join(__dirname, file), "utf8");
    // Busca asignaciones de string literal sospechosamente largas a algo
    // parecido a una clave — no debería haber ninguna, todas vienen de
    // process.env.
    const suspicious = /(?:apiKey|API_KEY)\s*[:=]\s*["'][A-Za-z0-9_-]{20,}["']/.test(source);
    assert.equal(suspicious, false, `${file} parece tener una clave hardcodeada`);
  }
});
