import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { parseLoudnormJson, measureLoudness, masterAudioLoudness, LOUDNESS_TARGET } from "./audio-master";

// Texto real de ejemplo que imprime el filtro loudnorm de ffmpeg en
// stderr con print_format=json (recortado a lo relevante) — permite
// probar el parseo sin invocar ffmpeg de verdad.
const SAMPLE_STDERR = `
[Parsed_loudnorm_0 @ 0x56127a1b2c40]
{
	"input_i" : "-22.49",
	"input_tp" : "-8.52",
	"input_lra" : "3.20",
	"input_thresh" : "-33.01",
	"output_i" : "-16.00",
	"output_tp" : "-1.50",
	"output_lra" : "3.10",
	"output_thresh" : "-26.20",
	"normalization_type" : "dynamic",
	"target_offset" : "0.00"
}
`;

test("parseLoudnormJson extrae el bloque JSON de la salida cruda de ffmpeg", () => {
  const parsed = parseLoudnormJson(SAMPLE_STDERR);
  assert.equal(parsed.input_i, "-22.49");
  assert.equal(parsed.input_tp, "-8.52");
});

test("parseLoudnormJson lanza un error claro si no encuentra un bloque JSON", () => {
  assert.throws(() => parseLoudnormJson("ffmpeg version 6.1.1, no loudnorm output here"));
});

test("LOUDNESS_TARGET coincide con el objetivo de -16 LUFS / -1.5 dBTP pedido", () => {
  assert.equal(LOUDNESS_TARGET.INTEGRATED_LUFS, -16);
  assert.equal(LOUDNESS_TARGET.TRUE_PEAK_DBTP, -1.5);
});

// Prueba de integración real con ffmpeg — se salta automáticamente si el
// binario no está disponible en el entorno donde corre (p. ej. una
// máquina de desarrollo sin ffmpeg instalado); en CI/GitHub Actions se
// instala explícitamente (ver .github/workflows/render.yml) así que ahí
// sí se ejecuta de verdad, con archivos reales, no solo con texto de
// muestra.
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

test(
  "medición y masterización reales con ffmpeg sobre un archivo sintético muy silencioso",
  { skip: !hasFfmpeg && "ffmpeg no está disponible en este entorno" },
  async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atomivid-audio-master-test-"));
    const input = path.join(dir, "input.mp4");
    const output = path.join(dir, "output.mp4");

    try {
      const gen = spawnSync("ffmpeg", [
        "-y",
        "-f", "lavfi", "-i", "color=c=black:s=320x240:d=2:r=10",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
        "-af", "volume=0.05",
        "-c:v", "libx264",
        "-c:a", "aac",
        "-shortest",
        input,
      ]);
      assert.equal(gen.status, 0, `no se pudo generar el archivo de prueba: ${gen.stderr}`);

      const before = await measureLoudness(input);
      // El archivo de prueba es deliberadamente muy silencioso (volume=0.05).
      assert.ok(before.integratedLufs < -30, `esperaba un archivo muy silencioso, midió ${before.integratedLufs} LUFS`);

      const result = await masterAudioLoudness(input, output);
      // La medición POSTERIOR (sobre el archivo ya masterizado, no solo el
      // parámetro configurado) debe caer cerca del objetivo real.
      assert.ok(
        Math.abs(result.after.integratedLufs - LOUDNESS_TARGET.INTEGRATED_LUFS) < 1,
        `esperaba ~${LOUDNESS_TARGET.INTEGRATED_LUFS} LUFS después de masterizar, midió ${result.after.integratedLufs}`,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
