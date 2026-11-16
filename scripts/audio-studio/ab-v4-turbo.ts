/**
 * A/B de 90 s: eleven_multilingual_v2 frente a eleven_v4_turbo con LA MISMA voz y el mismo texto (extracto de
 * «El día que entiendes que no puedes controlarlo todo»). Una solicitud por modelo (≤ 10.000 caracteres).
 *  - fixture (por defecto, USD 0): espeak-ng local. Comprueba extracto, costos, claves de caché separadas y archivos.
 *  - real: ElevenLabs (DE PAGO). Solo corre con AB_CONFIRMAR_USD igual al monto exacto que imprime el modo fixture
 *    (tope conservador: tarifa de producción para ambos modelos). Sin confirmación exacta no llama a la API.
 * Uso: npx tsx scripts/audio-studio/ab-v4-turbo.ts [fixture|real] <dirSalida>
 *      real: ELEVENLABS_API_KEY, AB_VOZ_ID, AB_CONFIRMAR_USD
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SEED_EPISODE } from "../../src/lib/audio-studio/seed";
import { modelRate, TTS_MODELS, type TtsModelId } from "../../src/lib/audio-studio/model";
import { elevenLabsProvider, fixtureVoice, segmentKey, settingsFor } from "../../src/lib/audio-studio/voice";
import { ffprobeDuration } from "../../src/lib/podcast/v3/ffmpeg";

/** ~90 s de narración pausada en español ≈ 1.300 caracteres (≈ 14,5 car/s, medido en el episodio de 18 min). */
export const AB_TARGET_CHARS = 1300;

export function abExcerpt(script = SEED_EPISODE.script, target = AB_TARGET_CHARS): string {
  const paras = script.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !p.startsWith("#"));
  let out = "";
  // Párrafos completos mientras no se pase del objetivo (nunca corta una frase a la mitad).
  for (const p of paras) { const next = out ? `${out}\n\n${p}` : p; if (out && next.length > target) break; out = next; }
  return out;
}

async function main() {
  const [mode = "fixture", outDir = "ab-v4-turbo"] = process.argv.slice(2);
  const text = abExcerpt();
  const models = TTS_MODELS.map((m) => m.id) as TtsModelId[];
  const rates = Object.fromEntries(models.map((m) => [m, modelRate(m)]));
  // Tope del A/B: nunca por debajo de la tarifa efectiva de producción (sin descuentos no comprobados).
  const capUsd = Math.ceil(models.reduce((s, m) => s + (text.length / 1000) * rates[m].rate, 0) * 100) / 100;
  console.log(`EXTRACTO caracteres=${text.length} palabras=${text.split(/\s+/).length}`);
  for (const m of models) console.log(`TARIFA ${m} usada=${rates[m].rate} lista=${rates[m].listUsdPer1k} fuente=${rates[m].source} costo_lista=${((text.length / 1000) * rates[m].listUsdPer1k).toFixed(4)}`);
  console.log(`TOPE_AB_USD ${capUsd.toFixed(2)}`);

  let voiceId = "fixture-voz";
  let providerFor: (m: TtsModelId) => ReturnType<typeof elevenLabsProvider>;
  if (mode === "real") {
    voiceId = process.env.AB_VOZ_ID?.trim() ?? "";
    if (!/^[A-Za-z0-9]{8,64}$/.test(voiceId)) { console.log("RESULTADO BLOQUEADO falta AB_VOZ_ID válido (USD 0)"); process.exit(2); }
    if (process.env.AB_CONFIRMAR_USD?.trim() !== capUsd.toFixed(2)) { console.log(`RESULTADO BLOQUEADO AB_CONFIRMAR_USD debe ser exactamente ${capUsd.toFixed(2)} (USD 0, no se llamó a la API)`); process.exit(2); }
    providerFor = (m) => elevenLabsProvider(m, rates[m].rate);
  } else {
    const fx = fixtureVoice();
    providerFor = (m) => fx.provider(m) as ReturnType<typeof elevenLabsProvider>;
  }

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "extracto.txt"), text + "\n");
  const rows: string[] = ["modelo,clave_cache,segundos,usd,sha256"];
  let total = 0;
  for (const m of models) {
    const p = providerFor(m);
    const key = segmentKey(p.name, m, voiceId, text, settingsFor(m), "es");
    const dest = path.join(outDir, `${mode}-${m}.mp3`);
    const t0 = Date.parse(new Date().toISOString());
    // Un fallo NO cambia de modelo ni reintenta: se informa y se detiene (nunca doble cobro).
    const { actualUsd } = await p.synth(text, voiceId, dest);
    total += actualUsd;
    const secs = await ffprobeDuration(dest);
    const sha = createHash("sha256").update(await readFile(dest)).digest("hex");
    rows.push(`${m},${key},${secs.toFixed(1)},${actualUsd.toFixed(4)},${sha}`);
    console.log(`AB ${m} segundos=${secs.toFixed(1)} usd=${actualUsd.toFixed(4)} ms=${Date.parse(new Date().toISOString()) - t0} clave=${key.slice(0, 12)}`);
  }
  await writeFile(path.join(outDir, "ab.csv"), rows.join("\n") + "\n");
  const keys = rows.slice(1).map((r) => r.split(",")[1]);
  console.log(`RESULTADO OK modo=${mode} usd_total=${total.toFixed(4)} claves_distintas=${new Set(keys).size === keys.length}`);
}

if (process.argv[1]?.endsWith("ab-v4-turbo.ts")) main().catch((e) => { console.log("RESULTADO ERROR", e instanceof Error ? e.message : String(e)); process.exit(1); });
