"""Small SYNTHETIC fixtures (ffmpeg lavfi) for the v2 unit tests. 320x180 output keeps renders fast."""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY = sys.executable


def ff(*a):
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", *a], check=True)


def meta(base: Path, fid: str, rel: str, role: str) -> dict:
    p = base / rel
    return {"id": fid, "path": rel, "size": p.stat().st_size,
            "sha256": hashlib.sha256(p.read_bytes()).hexdigest(), "role": role}


def write_manifest(d: Path, m: dict, ready: bool = True) -> Path:
    mp = d / "montaje.json"
    mp.write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")
    if ready:
        (d / "LISTO.json").write_text(json.dumps({"manifest_sha256": hashlib.sha256(mp.read_bytes()).hexdigest(),
                                                  "file_count": len(m["files"]), "episode_id": m["episode_id"],
                                                  "assembly_version": m["assembly_version"]}))
    return mp


def media_set(d: Path) -> Path:
    """medios/: fondo.png, anim12.mp4 (12 s video, no audio), avatar_corto.mp4 (video 8 s / audio 6 s),
    voz5.wav (5 s)."""
    m = d / "medios"
    m.mkdir(parents=True, exist_ok=True)
    if not (m / "fondo.png").exists():
        ff("-f", "lavfi", "-i", "testsrc2=s=320x180", "-frames:v", "1", str(m / "fondo.png"))
        ff("-f", "lavfi", "-i", "testsrc2=s=320x180:r=25:d=12", "-c:v", "libx264", "-preset", "ultrafast",
           "-pix_fmt", "yuv420p", str(m / "anim12.mp4"))
        ff("-f", "lavfi", "-i", "testsrc=s=320x180:r=25:d=8", "-f", "lavfi", "-i", "sine=f=300:d=6",
           "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", str(m / "avatar_corto.mp4"))
        ff("-f", "lavfi", "-i", "sine=f=500:d=5:sample_rate=48000", str(m / "voz5.wav"))
    return m


def premix(d: Path, seconds: float = 12.34, kind: str = "wav") -> str:
    """Premixed program audio with a LOUD, distinctive ending (last 1.5 s) so truncation or
    an altered ending is detectable. kind: wav (48 kHz s16), mp3 (44.1 kHz), m4a (AAC 48 kHz)."""
    m = d / "medios"
    m.mkdir(parents=True, exist_ok=True)
    body = seconds - 1.5
    expr = (f"if(lt(t\\,{body:.3f})\\,0.08*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*0.5*t))\\,"
            f"0.5*sin(2*PI*880*t))")
    sr = 44100 if kind == "mp3" else 48000
    wav = m / f"mezcla_{kind}_src.wav"
    ff("-f", "lavfi", "-i", f"aevalsrc={expr}|{expr}:s={sr}:d={seconds}", "-c:a", "pcm_s16le", str(wav))
    if kind == "wav":
        out = m / "mezcla.wav"
        wav.rename(out)
    elif kind == "mp3":
        out = m / "mezcla.mp3"
        ff("-i", str(wav), "-c:a", "libmp3lame", "-b:a", "192k", str(out))
        wav.unlink()
    else:
        out = m / "mezcla.m4a"
        ff("-i", str(wav), "-c:a", "aac", "-b:a", "192k", str(out))
        wav.unlink()
    return f"medios/{out.name}"


def base_manifest(d: Path, files: list, timeline: list, **extra) -> dict:
    m = {"schema": "podcast-editor/montaje@2", "episode_id": "prueba-v2", "assembly_version": 1,
         "files": files,
         "output": {"width": 320, "height": 180, "fps": 25, "crf": 30, "preset": "ultrafast", "threads": 2,
                    "metadata": {"title": "prueba sintética v2"}},
         "timeline": timeline}
    m.update(extra)
    return m


def run_editor(*args, env=None):
    import os
    return subprocess.run([PY, str(ROOT / "editor.py"), *map(str, args)], capture_output=True, text=True,
                          env={**os.environ, **(env or {})})
