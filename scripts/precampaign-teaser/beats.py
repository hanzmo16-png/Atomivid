"""Local beat grid for the curated music (numpy only, no API).
Usage: python3 beats.py <music.wav (mono 22050)> <out.json>
Onset envelope (spectral flux) -> tempo by autocorrelation (70-180 BPM) -> beat phase.
"""
import json
import sys
import wave

import numpy as np

path, out = sys.argv[1], sys.argv[2]
with wave.open(path, "rb") as w:
    sr = w.getframerate()
    x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
hop, win = 256, 2048
frames = 1 + (len(x) - win) // hop
spec = np.abs(np.fft.rfft(np.stack([x[i * hop:i * hop + win] * np.hanning(win) for i in range(frames)]), axis=1))
flux = np.maximum(0, np.diff(np.log1p(spec), axis=0)).sum(axis=1)
flux = (flux - flux.mean()) / (flux.std() + 1e-9)
fps = sr / hop
ac = np.correlate(flux, flux, mode="full")[len(flux) - 1:]
lags = np.arange(len(ac))
bpm_of = lambda lag: 60.0 * fps / lag
valid = (lags > 0) & (bpm_of(np.maximum(lags, 1)) >= 70) & (bpm_of(np.maximum(lags, 1)) <= 180)
lag = int(lags[valid][np.argmax(ac[valid])])
# Sub-frame period by parabolic interpolation around the autocorrelation peak.
y0, y1, y2 = ac[lag - 1], ac[lag], ac[lag + 1]
den = y0 - 2 * y1 + y2
period = (lag + (0.5 * (y0 - y2) / den if den != 0 else 0.0)) / fps
times = (np.arange(len(flux)) + 1) / fps + win / (2 * sr)  # flux[i]: change into frame i+1, centred on its window
# Fractional phase search (5 ms steps) on the interpolated onset curve.
best, phase = -1e9, 0.0
for ph in np.arange(0, period, 0.005):
    grid = np.arange(ph, times[-1], period)
    s = np.interp(grid, times, flux).sum()
    if s > best:
        best, phase = s, float(ph)
dur = len(x) / sr
beats = [round(phase + i * period, 3) for i in range(int((dur - phase) / period) + 1)]
json.dump({"bpm": round(60.0 / period, 2), "period": round(period, 4), "phase": round(phase, 4), "beats": beats}, open(out, "w"))
print(json.dumps({"bpm": round(60.0 / period, 2), "beats": len(beats)}))
