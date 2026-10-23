#!/usr/bin/env python3
"""Evidencia AV local (USD 0): audio narrado real del episodio + tarjeta del hablante activo + subtítulos por hablante,
a partir de production_timeline. NO es el pipeline de video del producto (worker/Pexels); es un render de verificación.
Uso: evidence-mp4.py <timeline.json> <audio.m4a> <out.mp4> "<Nombre A>" ["<Nombre B>"]"""
import json, subprocess, sys, tempfile, os
tl, audio, out = json.load(open(sys.argv[1])), sys.argv[2], sys.argv[3]
names = {"A": sys.argv[4], "B": sys.argv[5] if len(sys.argv) > 5 else "B"}
colors = {"A": "0x1d3557", "B": "0x6a040f"}
d = tempfile.mkdtemp()
font = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
def card(sp):
    p = f"{d}/{sp}.png"
    label = names[sp].replace(":", "\\:").replace("'", "")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c={colors[sp]}:s=1280x720", "-vf",
        f"drawtext=fontfile={font}:text='{label}':fontcolor=white:fontsize=64:x=(w-tw)/2:y=250,drawtext=fontfile={font}:text='Imagen de participante (no avatar)':fontcolor=0xdddddd:fontsize=28:x=(w-tw)/2:y=350",
        "-frames:v", "1", p], check=True)
    return p
cards = {sp: card(sp) for sp in {e["speaker"] for e in tl}}
dur = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", audio]).decode())
lst = open(f"{d}/list.txt", "w"); t = 0.0
for i, e in enumerate(tl):
    end = tl[i + 1]["start"] if i + 1 < len(tl) else dur
    lst.write(f"file '{cards[e['speaker']]}'\nduration {max(0.04, end - t):.3f}\n"); t = end
lst.write(f"file '{cards[tl[-1]['speaker']]}'\n"); lst.close()
def ts(s): h, m = int(s // 3600), int(s % 3600 // 60); return f"{h}:{m:02d}:{s % 60:05.2f}"
ass = open(f"{d}/s.ass", "w", encoding="utf8")
ass.write("[Script Info]\nPlayResX: 1280\nPlayResY: 720\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BorderStyle, Outline, Alignment, MarginV\n"
          "Style: A,DejaVu Sans,30,&H00FFE7A8,&H00000000,1,2,2,40\nStyle: B,DejaVu Sans,30,&H00A8C8FF,&H00000000,1,2,2,40\n\n[Events]\nFormat: Layer, Start, End, Style, Text\n")
for e in tl:
    words = e["text"].split(); chunks = [words[i:i + 12] for i in range(0, len(words), 12)] or [[]]
    span = (e["end"] - e["start"]) / len(chunks)
    for k, c in enumerate(chunks):
        a = e["start"] + k * span
        ass.write(f"Dialogue: 0,{ts(a)},{ts(a + span)},{e['speaker']},[{names[e['speaker']]}] {' '.join(c)}\n")
ass.close()
subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", f"{d}/list.txt", "-i", audio, "-vf", f"ass={d}/s.ass,fps=12,format=yuv420p",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "34", "-tune", "stillimage", "-c:a", "copy", "-shortest", "-movflags", "+faststart", out], check=True)
print(out)
