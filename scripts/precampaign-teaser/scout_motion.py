"""Camera-motion / scene-motion estimate for a stock clip (free scouting, local).

cameraShiftPxPerSec: median global translation (phase correlation, 320 px wide proxy) -> ~0 means a
locked-off tripod shot (required behind a fixed camera). localMotion: mean abs residual after global
alignment (traffic, screens, pedestrians). Writes a 3-frame strip. usage: scout_motion.py <video> <strip.jpg>
"""
import json, subprocess, sys
import numpy as np
import cv2

video, strip = sys.argv[1:3]
raw = subprocess.run(["ffmpeg", "-v", "error", "-i", video, "-vf", "fps=6,scale=320:-2", "-pix_fmt", "gray", "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", video], capture_output=True, text=True).stdout.strip().split(",")
w = 320
h = int(round(int(probe[1]) * 320 / int(probe[0]) / 2) * 2)
F = np.frombuffer(raw, np.uint8).reshape(-1, h, w).astype(np.float32)
win = cv2.createHanningWindow((w, h), cv2.CV_32F)
shifts, local = [], []
for i in range(1, len(F)):
    (dx, dy), _ = cv2.phaseCorrelate(F[i - 1], F[i], win)
    shifts.append(np.hypot(dx, dy) * 6)
    M = np.float32([[1, 0, -dx], [0, 1, -dy]])
    al = cv2.warpAffine(F[i], M, (w, h), borderMode=cv2.BORDER_REFLECT)
    local.append(float(np.abs(al - F[i - 1])[8:-8, 8:-8].mean()))
n = len(F)
frames = []
for k in (0, n // 2, n - 1):
    c = cv2.cvtColor(F[k].astype(np.uint8), cv2.COLOR_GRAY2BGR)
    frames.append(c)
col = subprocess.run(["ffmpeg", "-v", "error", "-i", video, "-vf", f"select='eq(n\\,0)+eq(n\\,{max(1, n * 5 // 2)})',scale=320:-2", "-vsync", "0", "-frames:v", "2", "-pix_fmt", "bgr24", "-f", "rawvideo", "-"], capture_output=True).stdout
if len(col) >= h * w * 3:
    frames[0] = np.frombuffer(col[: h * w * 3], np.uint8).reshape(h, w, 3).copy()
cv2.imwrite(strip, np.hstack(frames))
print(json.dumps({
    "cameraShiftPxPerSec": round(float(np.median(shifts)) if shifts else 0.0, 2),
    "cameraShiftP90": round(float(np.percentile(shifts, 90)) if shifts else 0.0, 2),
    "localMotion": round(float(np.mean(local)) if local else 0.0, 2),
    "meanLuma": round(float(F.mean()), 1),
}))
