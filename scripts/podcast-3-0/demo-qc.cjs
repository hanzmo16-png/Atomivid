// QC de los demos de Podcast 3.0: −16±1 LUFS, TP ≤ −1 dBTP, sin recortes, música presente en las pausas (> −50 dBFS).
const r = require(require("node:path").resolve(process.argv[2] ?? "demo-out", "resumen.json"));
let bad = 0;
for (const m of r) {
  const a = m.mp4_audio, ok = Math.abs(a.lufs + 16) <= 1 && a.true_peak_dbtp <= -1 && a.recortes === 0 && m.energia_media_pausas_dbfs != null && m.energia_media_pausas_dbfs > -50;
  console.log(m.modo, ok ? "OK" : "FALLA", JSON.stringify({ ...a, pausas_dbfs: m.energia_media_pausas_dbfs, musica: m.musica, s: m.duracion_s }));
  if (!ok) bad++;
}
if (r.length !== 3) { console.log("FALLA: se esperaban 3 modos"); bad++; }
process.exit(bad ? 1 : 0);
