/**
 * Demo Podcast 3.0: un episodio por modo con proveedores SIMULADOS (USD 0). Uso: npx tsx scripts/podcast-3-0/demo.ts <salida> [small]
 * Escribe MP4 + audio + qc.json por modo. NO es una prueba de proveedores reales.
 */
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { runEpisode, MemoryRunGuard, preflight } from "../../src/lib/podcast/v3/pipeline";
import { MemoryLedger } from "../../src/lib/podcast/v3/cost";
import { mockProviders } from "../../src/lib/podcast/v3/mocks";
import { ebur128, readPcm, rmsDb } from "../../src/lib/podcast/v3/ffmpeg";
import { NARRACION, AVATAR, DIALOGO } from "./fixtures";
import { StudioSpec } from "../../src/lib/podcast/v3/spec";
// Podcast 2.1 «Solo audio»: dos voces, música, sin imágenes (proveedor visual «solo_set»); el entregable es el MP3.
const SOLO_AUDIO = StudioSpec.parse({ ...NARRACION, title: "Solo audio: la señal Wow!", visual: { ...NARRACION.visual, provider: "solo_set", recreations: false } });

async function main() {
  const out = path.resolve(process.argv[2] ?? "podcast-3-0-demo");
  const small = process.argv[3] !== "full";
  await mkdir(out, { recursive: true });
  const summary: Record<string, unknown>[] = [];
  for (const [name, spec] of [["modo-0-solo-audio", SOLO_AUDIO], ["modo-a-narracion", NARRACION], ["modo-b-avatar", AVATAR], ["modo-c-dialogo", DIALOGO]] as const) {
    const providers = mockProviders();
    const ledger = new MemoryLedger();
    const pf = await preflight(spec, providers);
    const t0 = Date.now();
    const r = await runEpisode(spec, { owner: "demo-user", episode: name, dir: path.join(out, name), providers, ledger, guard: new MemoryRunGuard(), authorizedUsd: pf.estimate.totalUsd + 1, small, musicDir: path.join(out, "music") });
    const mp4qc = await ebur128(r.mp4);
    const pcm = await readPcm(r.mp4, 16000);
    const gaps = r.timeline.slice(0, -1).map((e, i) => [e.end + 0.08, r.timeline[i + 1].start - 0.05]).filter(([a, b]) => b - a > 0.15);
    const gapDb = gaps.length ? gaps.map(([a, b]) => rmsDb(pcm, 16000, a, b)).reduce((s, x) => s + x, 0) / gaps.length : null;
    const row = { modo: name, mp4: path.relative(out, r.mp4), audio: path.relative(out, r.audio), mp4_bytes: (await stat(r.mp4)).size, duracion_s: +r.durationSeconds.toFixed(2),
      master: { lufs: r.lufs, true_peak_dbtp: r.truePeak, recortes: r.clipped }, mp4_audio: { lufs: mp4qc.lufs, true_peak_dbtp: mp4qc.truePeak, recortes: mp4qc.clipped },
      musica: r.musicTrack, ambiente: r.mood, energia_media_pausas_dbfs: gapDb && +gapDb.toFixed(1), planos: r.plan.shots.map((s) => s.kind),
      estimacion_usd: pf.estimate, gasto_simulado_usd: r.spentUsd, llamadas: { tts: providers.calls.tts.length, avatar: providers.calls.avatar.length, recreaciones: providers.calls.recreate.length },
      proveedores: r.providers, segundos_render: Math.round((Date.now() - t0) / 1000) };
    await writeFile(path.join(out, `${name}-qc.json`), JSON.stringify(row, null, 2));
    summary.push(row);
    console.log(JSON.stringify({ modo: name, dur: row.duracion_s, mp4: row.mp4_audio, gapDb: row.energia_media_pausas_dbfs, planos: row.planos.length, usd: r.spentUsd, s: row.segundos_render }));
  }
  await writeFile(path.join(out, "resumen.json"), JSON.stringify(summary, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
