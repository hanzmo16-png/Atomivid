"""Thin ffmpeg/ffprobe helpers (stdlib only)."""
from __future__ import annotations

import ctypes
import json
import signal
import subprocess
from pathlib import Path

PR_SET_PDEATHSIG = 1


def _die_with_parent():
    # Linux: if the editor is killed (even SIGKILL) its ffmpeg children die too,
    # so a resumed run never races an orphan writing the same temp file.
    try:
        ctypes.CDLL("libc.so.6", use_errno=True).prctl(PR_SET_PDEATHSIG, signal.SIGKILL)
    except Exception:
        pass


class FFError(RuntimeError):
    pass


def run(args: list[str], log: Path | None = None, capture: bool = True) -> str:
    r = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, preexec_fn=_die_with_parent)
    err = r.stderr.decode(errors="replace")
    if log is not None:
        with open(log, "a", encoding="utf-8") as f:
            f.write("$ " + " ".join(args) + "\n" + err[-20000:] + "\n")
    if r.returncode:
        raise FFError(f"{Path(args[0]).name} exit {r.returncode}: {err[-1500:]}")
    return r.stdout.decode(errors="replace") if capture else ""


def ffmpeg(args: list[str], log: Path | None = None) -> str:
    return run(["ffmpeg", "-nostdin", "-hide_banner", "-v", "error", "-y", *args], log)


def probe(path: Path) -> dict:
    out = run(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)])
    return json.loads(out)


def duration(path: Path) -> float:
    return float(probe(path)["format"]["duration"])


def decode_errors(path: Path) -> str:
    """Full decode; returns stderr text (empty == zero errors)."""
    r = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-f", "null", "-"],
                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       preexec_fn=_die_with_parent)
    txt = r.stderr.decode(errors="replace").strip()
    if r.returncode and not txt:
        txt = f"ffmpeg exit {r.returncode}"
    return txt


def fraction(s: str) -> float:
    if "/" in s:
        a, b = s.split("/")
        return float(a) / float(b) if float(b) else 0.0
    return float(s)


# ---------------------------------------------------------------------------
# v2 helpers: per-stream durations, decoded audio stats, tail comparison
# ---------------------------------------------------------------------------

def stream_info(path: Path) -> dict:
    """Durations (s) of the first video and first audio stream, falling back to the
    container duration when a stream does not carry its own (mkv/webm)."""
    pr = probe(path)
    fmt = float(pr.get("format", {}).get("duration") or 0.0)
    out = {"format": fmt, "video": None, "audio": None, "audio_codec": None,
           "sample_rate": None, "channels": None}
    for s in pr.get("streams", []):
        t = s.get("codec_type")
        if t == "video" and out["video"] is None and s.get("disposition", {}).get("attached_pic", 0) == 0:
            d = s.get("duration")
            if d in (None, "N/A") and s.get("nb_frames") and s.get("avg_frame_rate", "0/0") != "0/0":
                d = int(s["nb_frames"]) / fraction(s["avg_frame_rate"])
            out["video"] = float(d) if d not in (None, "N/A") else fmt
        elif t == "audio" and out["audio"] is None:
            d = s.get("duration")
            out["audio"] = float(d) if d not in (None, "N/A") else fmt
            out["audio_codec"] = s.get("codec_name")
            out["sample_rate"] = int(s.get("sample_rate") or 0)
            out["channels"] = int(s.get("channels") or 0)
    return out


def audio_stats(path: Path) -> dict:
    """Fully decode the first audio stream (no resampling) and return
    {samples, sample_rate, duration, rms_db, peak_db} measured by ffmpeg astats."""
    info = stream_info(path)
    sr = info["sample_rate"]
    if not sr:
        raise FFError(f"{path}: no audio stream")
    r = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-i", str(path), "-map", "0:a:0",
                        "-af", "astats=measure_perchannel=none", "-f", "null", "-"],
                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       preexec_fn=_die_with_parent)
    txt = r.stderr.decode(errors="replace")
    if r.returncode:
        raise FFError("astats failed: " + txt[-800:])
    sec = txt[txt.rfind("] Overall"):]
    vals = {}
    for line in sec.splitlines():
        if "] " in line and ":" in line:
            k, _, v = line.split("] ", 1)[1].partition(":")
            vals[k.strip()] = v.strip()
    n = int(float(vals.get("Number of samples", "0")))

    def db(k):
        v = vals.get(k, "-inf")
        try:
            return float(v)
        except ValueError:
            return float("-inf")
    return {"samples": n, "sample_rate": sr, "duration": n / sr, "rms_db": db("RMS level dB"),
            "peak_db": db("Peak level dB"), "codec": info["audio_codec"], "channels": info["channels"]}


def pcm_window(path: Path, start: float, dur: float, sr: int = 48000) -> list[float]:
    """Decode [start, start+dur) of the first audio stream as mono float samples in [-1, 1].
    Used only for analysis (tail comparison); resampling here never touches outputs."""
    import array
    r = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{max(0.0, start):.6f}", "-i", str(path),
                        "-map", "0:a:0", "-t", f"{dur:.6f}", "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"],
                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       preexec_fn=_die_with_parent)
    if r.returncode:
        raise FFError("pcm decode failed: " + r.stderr.decode(errors="replace")[-500:])
    a = array.array("h")
    a.frombytes(r.stdout[: len(r.stdout) // 2 * 2])
    return [x / 32768.0 for x in a]


def rms_db(samples) -> float:
    import math
    if not samples:
        return float("-inf")
    s = sum(x * x for x in samples) / len(samples)
    return 10 * math.log10(s) if s > 0 else float("-inf")


def compare_tail(src: Path, out: Path, src_duration: float, tail: float = 2.0, windows: int = 4,
                 sr: int = 48000, tol_db: float = 1.5, silence_db: float = -60.0) -> dict:
    """Compare the last `tail` seconds of the SOURCE timeline in source vs output.
    Windows are taken at the same absolute timestamps in both files, so a truncated
    output (missing samples) or an altered ending (fade/limiter) is detected."""
    start = max(0.0, src_duration - tail)
    a = pcm_window(src, start, tail, sr)
    b = pcm_window(out, start, tail, sr)
    n = max(1, round(tail * sr / windows))
    res = {"start": round(start, 3), "src_samples": len(a), "out_samples": len(b), "windows": [], "ok": True}
    if len(b) < len(a) - round(0.040 * sr):
        res["ok"] = False
        res["reason"] = f"output tail has {len(b)} samples, source {len(a)} (truncated ending)"
    for k in range(windows):
        ra, rb = rms_db(a[k * n:(k + 1) * n]), rms_db(b[k * n:(k + 1) * n])
        quiet = ra < silence_db and rb < silence_db
        ok = quiet or (abs(ra - rb) <= tol_db if ra != float("-inf") and rb != float("-inf") else False)
        res["windows"].append({"src_db": round(ra, 2), "out_db": round(rb, 2), "ok": ok})
        if not ok:
            res["ok"] = False
    return res
