# Subtítulos QUEMADOS (Remotion LongFormDoc: caja oscura con texto blanco, abajo al centro). Sin OCR: mide, en fotogramas
# muestreados cada 4 s, la fracción de píxeles blancos en la franja inferior central frente a una franja superior de control.
# Uso: python3 captions-probe.py <video.mp4>  → JSON. Heurística: confirma presencia, no lee el texto.
import json, subprocess, sys
import numpy as np
W, H = 480, 270
raw = subprocess.run(["ffmpeg", "-v", "error", "-i", sys.argv[1], "-vf", "fps=1/4,scale=480:270", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
frames = np.frombuffer(raw, np.uint8).reshape(-1, H, W, 3)
white = lambda b: float((b > 225).all(-1).mean())
bottom = [white(f[195:262, 180:300]) for f in frames]; top = [white(f[20:87, 180:300]) for f in frames]
hits = sum(1 for b, t in zip(bottom, top) if b >= 0.004 and t < 0.001)
print(json.dumps({"frames": len(frames), "withCaption": hits, "ratio": round(hits / max(1, len(frames)), 3), "bottomWhiteMedian": round(float(np.median(bottom)), 4), "topWhiteMax": round(max(top), 4)}))
