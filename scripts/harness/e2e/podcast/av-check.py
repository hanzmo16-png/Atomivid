#!/usr/bin/env python3
"""Comprobaciones AV objetivas (USD 0). Uso: av-check.py <con_musica.(m4a|mp4)> <sin_musica.m4a> <timeline.json>
- La música no corta ni enmascara la voz: en cada turno, la envolvente de voz con música correlaciona con la de sin música.
- Sin distorsión: pico de muestra < -0.5 dBFS y sin muestras recortadas.
- La música existe: en los silencios entre turnos el nivel con música supera al de sin música.
Imprime JSON; código 0 si todo pasa."""
import json, subprocess, sys
import numpy as np
SR = 8000
def pcm(f):
    raw = subprocess.check_output(["ffmpeg", "-v", "error", "-i", f, "-vn", "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"])
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
def env(x, a, b, hop=0.05):
    seg = x[int(a * SR):int(b * SR)]; n = int(hop * SR); k = len(seg) // n
    return np.sqrt((seg[:k * n].reshape(k, n) ** 2).mean(axis=1) + 1e-12) if k else np.zeros(0)
def db(v): return float(20 * np.log10(max(v, 1e-9)))
m, s, tl = pcm(sys.argv[1]), pcm(sys.argv[2]), json.load(open(sys.argv[3]))
n = min(len(m), len(s)); m, s = m[:n], s[:n]
corr, gaps_m, gaps_s, worst = [], [], [], None
for i, t in enumerate(tl):
    a, b = t["start"], t["end"]
    em, es = env(m, a, b), env(s, a, b)
    if len(em) > 4 and es.std() > 0 and em.std() > 0:
        c = float(np.corrcoef(em, es)[0, 1]); corr.append(c)
        if worst is None or c < worst[1]: worst = (t["turn_id"], c)
    if i + 1 < len(tl) and tl[i + 1]["start"] - b > 0.25:
        g0, g1 = b + 0.05, tl[i + 1]["start"] - 0.05
        gaps_m.append(float(np.sqrt((m[int(g0*SR):int(g1*SR)] ** 2).mean() + 1e-12))); gaps_s.append(float(np.sqrt((s[int(g0*SR):int(g1*SR)] ** 2).mean() + 1e-12)))
peak = float(np.abs(m).max()); clipped = int((np.abs(m) >= 0.999).sum())
out = {"turnos": len(tl), "corr_min": round(min(corr), 3) if corr else None, "corr_media": round(float(np.mean(corr)), 3) if corr else None, "peor_turno": worst,
       "pico_dbfs": round(db(peak), 2), "muestras_recortadas": clipped, "silencios": len(gaps_m),
       "musica_en_silencios_db": round(db(float(np.median(gaps_m))), 1) if gaps_m else None, "silencio_sin_musica_db": round(db(float(np.median(gaps_s))), 1) if gaps_s else None}
out["ok_voz_intacta"] = bool(corr) and min(corr) >= 0.85
out["ok_sin_distorsion"] = out["pico_dbfs"] < -0.5 and clipped == 0
out["ok_musica_presente"] = bool(gaps_m) and db(float(np.median(gaps_m))) > db(float(np.median(gaps_s))) + 6
print(json.dumps(out)); sys.exit(0 if out["ok_voz_intacta"] and out["ok_sin_distorsion"] and out["ok_musica_presente"] else 1)
