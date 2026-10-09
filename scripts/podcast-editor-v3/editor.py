#!/usr/bin/env python3
"""podcast-editor: local, private, resumable podcast/video assembly from a montaje.json.

No provider calls. Network only in the optional Supabase storage backend (fetch/publish/firmar,
user session, never service_role). Never generates voice/avatar/animation: it only edits
delivered media. See README.md and docs/CONTRATO.md.

Exit codes: 0 ok / already done, 1 validation refused, 2 render/verify/storage failed,
            3 locked by a live process, 4 inputs not ready (fetch), 5 storage conflict (publish).
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import re
import shutil
import socket
import sys
import time
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from podcast_editor import media  # noqa: E402
from podcast_editor.media import FFError, ffmpeg  # noqa: E402
from podcast_editor import storage as stg  # noqa: E402
from podcast_editor.storage import sha256_file, episode_prefix  # noqa: E402
from podcast_editor.schema import validate_manifest  # noqa: E402
from podcast_editor.subs import SubtitleTrack, header as ass_header, ass_time, ass_escape  # noqa: E402

EDITOR_VERSION = "0.3.0"
SCHEMA = "podcast-editor/montaje@2"
SCHEMAS = {"podcast-editor/montaje@1", SCHEMA}
AUDIO_MODES = {"editor", "mezcla_final"}
INSUF_MODES = {"rechazar", "congelar", "ajustar_velocidad"}
MP3_RATES = {32000, 44100, 48000}
SEG_TYPES = {"voice", "avatar", "image", "animation", "broll", "card"}
VIDEO_TYPES = {"avatar", "animation", "broll"}
NON_MEDIA_ROLES = {"subtitles_words", "credits", "metadata"}

DEFAULT_OUTPUT = {
    "width": 1920, "height": 1080, "fps": 25, "video_codec": "libx264", "crf": 23, "preset": "veryfast",
    "pix_fmt": "yuv420p", "audio_codec": "aac", "audio_bitrate": "192k", "sample_rate": 48000, "channels": 2,
    "mp3_bitrate": "192k", "loudness": {"integrated": -16.0, "true_peak": -1.5, "lra": 11.0},
    "pad_color": "0x101719", "threads": 3, "metadata": {},
}
DEFAULT_DUCKING = {"mode": "envelope", "threshold_rms": 0.025, "duck_gain": 0.58,
                   "attack": 0.33, "release": 0.025, "window_ms": 20}


class Refused(Exception):
    """Validation refusal (clean, nothing rendered)."""


class JobFailed(Exception):
    pass


def now() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def log(msg: str):
    print(f"[{dt.datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def sjson(obj) -> str:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def write_json(path: Path, obj):
    tmp = path.with_name(path.name + f".tmp{os.getpid()}")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def safe_name(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", str(s))


# ---------------------------------------------------------------------------
# Manifest + plan
# ---------------------------------------------------------------------------

class Plan:
    def __init__(self, manifest_path: Path):
        self.manifest_path = manifest_path.resolve()
        self.base = self.manifest_path.parent
        raw = self.manifest_path.read_bytes()
        self.manifest_sha256 = hashlib.sha256(raw).hexdigest()
        try:
            self.m = json.loads(raw)
        except json.JSONDecodeError as e:
            raise Refused(f"montaje.json is not valid JSON: {e}")
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self._validate_and_resolve()

    # -- helpers
    def err(self, msg):
        self.errors.append(msg)

    def file(self, fid):
        return self.files.get(fid)

    def path_of(self, fid) -> Path:
        return (self.base / self.files[fid]["path"]).resolve()

    def _validate_and_resolve(self):
        m = self.m
        if m.get("schema") not in SCHEMAS:
            self.err(f"schema must be '{SCHEMA}' (or legacy 'podcast-editor/montaje@1')")
        elif m.get("schema") != SCHEMA:
            self.warnings.append("legacy schema montaje@1: v2 rules apply (no implicit freeze/padding)")
        # audio mode (v2): "editor" (narration/music/ducking/loudnorm) or "mezcla_final" (premixed, untouched)
        self.audio = dict(m.get("audio") or {"modo": "editor"})
        self.audio_mode = self.audio.get("modo", "editor")
        if self.audio_mode not in AUDIO_MODES:
            self.err(f"audio.modo must be one of {sorted(AUDIO_MODES)}")
        self.premixed = self.audio_mode == "mezcla_final"
        if self.premixed:
            if self.audio.get("timeline", "exacto") not in ("exacto", "extender_ultimo"):
                self.err("audio.timeline must be 'exacto' or 'extender_ultimo'")
            for k in ("narration", "music"):
                if m.get(k):
                    self.err(f"audio.modo 'mezcla_final' forbids '{k}' (the premixed file already contains it)")
        self.episode_id = str(m.get("episode_id") or "")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,80}", self.episode_id):
            self.err("episode_id missing or invalid (allowed: A-Z a-z 0-9 _ -)")
        v = m.get("assembly_version")
        if not isinstance(v, int) or v < 1:
            self.err("assembly_version must be an integer >= 1")
            v = 0
        self.version = v
        self.job_key = hashlib.sha256(f"{self.episode_id}|{self.version}|{self.manifest_sha256}".encode()).hexdigest()

        out = dict(DEFAULT_OUTPUT)
        out.update(m.get("output") or {})
        out["loudness"] = {**DEFAULT_OUTPUT["loudness"], **((m.get("output") or {}).get("loudness") or {})}
        self.out = out
        self.W, self.H, self.fps, self.sr = int(out["width"]), int(out["height"]), int(out["fps"]), int(out["sample_rate"])
        if (self.W, self.H) != (1920, 1080):
            self.warnings.append(f"output {self.W}x{self.H} is not 1920x1080")
        if out["video_codec"] != "libx264" or out["audio_codec"] != "aac":
            self.err("this editor version exports H.264 (libx264) + AAC only")

        # files
        self.files = {}
        for f in m.get("files") or []:
            fid = f.get("id")
            if not fid or fid in self.files:
                self.err(f"file entry without unique id: {f}")
                continue
            for k in ("path", "size", "sha256", "role"):
                if k not in f:
                    self.err(f"file {fid}: missing '{k}'")
            p = str(f.get("path", ""))
            if p.startswith("/") or ".." in Path(p).parts:
                self.err(f"file {fid}: path must be relative and inside the episode folder")
            self.files[fid] = f
        if not self.files:
            self.err("files list is empty")

        def need_file(fid, ctx):
            if fid not in self.files:
                self.err(f"{ctx}: unknown file id '{fid}'")
                return False
            return True

        # timeline
        tl = m.get("timeline") or []
        if not tl:
            self.err("timeline is empty")
        chapters = {c["id"]: c for c in (m.get("chapters") or []) if "id" in c}
        tr = m.get("transitions") or {}
        seen = set()
        self.segments = []
        for i, s in enumerate(tl):
            sid = s.get("id") or f"seg{i + 1:03}"
            if sid in seen:
                self.err(f"duplicate segment id {sid}")
            seen.add(sid)
            t = s.get("type")
            if t not in SEG_TYPES:
                self.err(f"segment {sid}: type must be one of {sorted(SEG_TYPES)}")
                continue
            seg = dict(s, id=sid, index=i)
            seg.setdefault("transition_in", tr.get("default_in", {"type": "none"}))
            seg.setdefault("transition_out", tr.get("default_out", {"type": "none"}))
            if t != "card":
                if not need_file(s.get("source"), f"segment {sid}"):
                    continue
            if t in ("avatar", "voice") and s.get("background") not in (None, "color"):
                need_file(s["background"], f"segment {sid} background")
            if t in VIDEO_TYPES or t == "voice":
                seg["in"] = float(s.get("in", 0.0))
                if "out" in s and float(s["out"]) <= seg["in"]:
                    self.err(f"segment {sid}: out must be > in")
            if self.premixed:
                if s.get("use_audio"):
                    self.err(f"segment {sid}: use_audio is not allowed with audio.modo 'mezcla_final'")
                if t == "voice":
                    self.err(f"segment {sid}: type 'voice' is not allowed with audio.modo 'mezcla_final' (use image/card)")
                seg["use_audio"] = False
            else:
                seg["use_audio"] = bool(s.get("use_audio", t in ("avatar", "voice")))
            if s.get("fit_mode") == "stretch":
                self.err(f"segment {sid}: fit_mode 'stretch' was removed in v2; use "
                         "insuficiente {modo: 'ajustar_velocidad', factor_min, factor_max}")
            elif s.get("fit_mode") not in (None, "trim"):
                self.err(f"segment {sid}: fit_mode must be 'trim'")
            ins = s.get("insuficiente", {"modo": "rechazar"})
            if isinstance(ins, str):  # shorthand only for "rechazar" (other modes need their limits)
                ins = {"modo": ins}
            if not isinstance(ins, dict) or ins.get("modo") not in INSUF_MODES:
                self.err(f"segment {sid}: insuficiente.modo must be one of {sorted(INSUF_MODES)}")
                ins = {"modo": "rechazar"}
            elif ins["modo"] == "congelar":
                try:
                    if float(ins["max_segundos"]) <= 0:
                        raise ValueError
                except (KeyError, TypeError, ValueError):
                    self.err(f"segment {sid}: insuficiente 'congelar' needs max_segundos > 0")
            elif ins["modo"] == "ajustar_velocidad":
                try:
                    fmin, fmax = float(ins["factor_min"]), float(ins["factor_max"])
                    if not (0 < fmin <= 1 <= fmax):
                        raise ValueError
                except (KeyError, TypeError, ValueError):
                    self.err(f"segment {sid}: insuficiente 'ajustar_velocidad' needs 0 < factor_min <= 1 <= factor_max")
                if seg["use_audio"]:
                    self.err(f"segment {sid}: insuficiente 'ajustar_velocidad' cannot be combined with use_audio")
                if t not in VIDEO_TYPES:
                    self.err(f"segment {sid}: insuficiente 'ajustar_velocidad' only applies to video segments")
            if ins["modo"] != "rechazar" and t in ("image", "card"):
                self.err(f"segment {sid}: insuficiente does not apply to type '{t}'")
            seg["insuficiente"] = ins
            if t == "voice" and not seg["use_audio"]:
                self.err(f"segment {sid}: voice segments must use their audio")
            self.segments.append(seg)

        # durations (explicit, from in/out, or 'auto' within a chapter -> ported from edit.py)
        self.source_dur_cache = {}
        frame = 0
        i = 0
        segs = self.segments
        while i < len(segs):
            s = segs[i]
            if s.get("duration") == "auto":
                ch = s.get("chapter")
                if ch not in chapters or "end" not in chapters[ch]:
                    self.err(f"segment {s['id']}: duration 'auto' needs a chapter with 'end'")
                    i += 1
                    continue
                j = i
                while j < len(segs) and segs[j].get("chapter") == ch:
                    j += 1
                group = segs[i:j]
                endframe = round(float(chapters[ch]["end"]) * self.fps)
                fixed = sum(self._fixed_frames(g) for g in group if g.get("duration") != "auto")
                flex = [g for g in group if g.get("duration") == "auto"]
                remaining = endframe - frame - fixed
                if remaining < len(flex):
                    self.err(f"chapter {ch}: fixed segments exceed chapter end")
                    i = j
                    continue
                each = remaining / len(flex)
                acc = 0
                for g in group:
                    if g.get("duration") == "auto":
                        g["frames"] = round(each) if g is not flex[-1] else remaining - acc
                        acc += g["frames"]
                    else:
                        g["frames"] = self._fixed_frames(g)
                for g in group:
                    g["start_frame"] = frame
                    frame += g["frames"]
                i = j
                continue
            s["frames"] = self._fixed_frames(s)
            s["start_frame"] = frame
            frame += s["frames"]
            i += 1
        for s in segs:
            s["start"] = s.get("start_frame", 0) / self.fps
            s["dur"] = s.get("frames", 0) / self.fps
            if s.get("frames", 0) <= 0:
                self.err(f"segment {s['id']}: non-positive duration")
        self.total_frames = frame
        self.total = frame / self.fps
        self.total_samples = round(self.total * self.sr)

        exp = m.get("expected_total_seconds")
        deferred = self.premixed and self.audio.get("timeline") == "extender_ultimo"  # checked in resolve_media
        if exp is not None and not deferred and abs(float(exp) - self.total) > 0.5:
            self.err(f"timeline total {self.total:.3f}s differs from expected_total_seconds {exp}")

        # narration
        self.narration = m.get("narration")
        if self.narration:
            need_file(self.narration.get("source"), "narration")
        # music
        self.music = m.get("music") or {}
        for k, c in enumerate(self.music.get("cues") or []):
            need_file(c.get("source"), f"music cue {k}")
            if float(c.get("end", 0)) <= float(c.get("start", 0)):
                self.err(f"music cue {k}: end must be > start")
            if float(c.get("end", 0)) > self.total + 0.5:
                self.err(f"music cue {k}: ends after timeline")
        self.ducking = {**DEFAULT_DUCKING, **(self.music.get("ducking") or {})}
        # subtitles
        self.subs_cfg = m.get("subtitles")
        if self.subs_cfg:
            need_file(self.subs_cfg.get("source"), "subtitles")
            if self.subs_cfg.get("mode", "burn") not in ("burn", "mux", "sidecar"):
                self.err("subtitles.mode must be burn|mux|sidecar")
        self.chapters = m.get("chapters") or []
        if self.premixed:
            src = self.audio.get("source")
            if need_file(src, "audio.source") and self.files[src].get("role") not in (None, "mezcla_final", "premix"):
                self.warnings.append(f"audio.source '{src}' role is '{self.files[src].get('role')}' (expected 'mezcla_final')")
        self.media_resolved = False

    # ---------------- media-dependent checks (need verified files)
    def resolve_media(self):
        """v2 rules that need the real media: premixed audio length vs timeline, and
        source footage sufficiency per segment (no implicit freeze / padding)."""
        fr = 1.0 / self.fps
        self.stream_cache = {}

        def info(fid):
            if fid not in self.stream_cache:
                self.stream_cache[fid] = media.stream_info(self.path_of(fid))
            return self.stream_cache[fid]

        # 1. premixed audio decides the timeline length
        if self.premixed and self.audio.get("source") in self.files:
            st = media.audio_stats(self.path_of(self.audio["source"]))
            self.premix = st
            A = st["duration"]
            if st["sample_rate"] not in MP3_RATES and st["codec"] != "mp3":
                self.err(f"audio.source sample rate {st['sample_rate']} Hz cannot be carried to MP3 without "
                         f"resampling; deliver it at 44100 or 48000 Hz")
            if self.audio.get("timeline", "exacto") == "extender_ultimo" and self.segments:
                last = self.segments[-1]
                target = math.ceil(A * self.fps - 1e-6)
                nf = target - last["start_frame"]
                if nf <= 0:
                    self.err(f"audio.timeline 'extender_ultimo': segments before the last one already reach "
                             f"{last['start_frame'] / self.fps:.3f}s >= audio {A:.3f}s")
                else:
                    last["frames"] = nf
                    last["dur"] = nf / self.fps
                    self.total_frames = target
                    self.total = target / self.fps
                    self.total_samples = round(self.total * self.sr)
                    last["extendido_hasta_audio"] = True
            if abs(self.total - A) > fr + 1e-6:
                self.err(f"timeline {self.total:.3f}s ({self.total_frames} frames) does not match premixed audio "
                         f"{A:.3f}s (tolerance 1 frame = {fr:.3f}s); fix durations or use audio.timeline 'extender_ultimo'")
            exp = self.m.get("expected_total_seconds")
            if exp is not None and abs(float(exp) - self.total) > 0.5:
                self.err(f"timeline total {self.total:.3f}s differs from expected_total_seconds {exp}")

        # 2. footage sufficiency per segment
        for s in self.segments:
            t = s["type"]
            if t not in VIDEO_TYPES and t != "voice":
                continue
            if s.get("source") not in self.files:
                continue
            try:
                si = info(s["source"])
            except Exception as e:
                self.err(f"segment {s['id']}: cannot probe source: {str(e)[:200]}")
                continue
            ins = s["insuficiente"]
            mode = ins["modo"]
            dur, tin = s["dur"], s["in"]
            kind = "audio" if t == "voice" else "video"
            src_len = si[kind] if si[kind] is not None else None
            if src_len is None:
                self.err(f"segment {s['id']}: source '{s['source']}' has no {kind} stream")
                continue
            avail = src_len - tin
            req_span = (float(s["out"]) - tin) if "out" in s else None
            if avail <= 0:
                self.err(f"segment {s['id']}: in={tin:.3f}s is beyond the end of source '{s['source']}' ({src_len:.3f}s)")
                continue
            if req_span is not None and req_span > avail + fr:
                self.err(f"segment {s['id']}: out={float(s['out']):.3f}s is beyond the end of source "
                         f"'{s['source']}' ({kind} {src_len:.3f}s)")
                continue
            s["fuente_seg"] = round(src_len, 6)
            speed, freeze = 1.0, 0.0
            if mode == "ajustar_velocidad":
                span = req_span if req_span is not None else min(avail, dur)
                speed = span / dur
                if not (float(ins["factor_min"]) - 1e-9 <= speed <= float(ins["factor_max"]) + 1e-9):
                    self.err(f"segment {s['id']}: speed factor {speed:.4f} (material {span:.3f}s for {dur:.3f}s) "
                             f"outside [{ins['factor_min']}, {ins['factor_max']}]")
                    continue
                if abs(speed - 1.0) < 1e-6:
                    speed = 1.0
            else:
                span = min(req_span if req_span is not None else avail, avail)
                short = dur - span
                if short > fr + 1e-6:
                    if mode == "congelar" and short <= float(ins["max_segundos"]) + 1e-6:
                        freeze = short
                    else:
                        what = ("allowed freeze " + str(ins["max_segundos"]) + "s") if mode == "congelar" else \
                            "no insuficiente rule"
                        self.err(f"segment {s['id']}: source '{s['source']}' provides {span:.3f}s from in={tin:.3f}s "
                                 f"({kind} {src_len:.3f}s) but {dur:.3f}s are required; shortfall {short:.3f}s "
                                 f"({what}). Fix in/out/duration or set insuficiente "
                                 "{modo: 'congelar', max_segundos} / {modo: 'ajustar_velocidad', factor_min, factor_max}")
                        continue
            s["span"] = round(span, 6)
            s["velocidad"] = round(speed, 6)
            s["congelar_s"] = round(freeze, 6)
            if s["use_audio"]:
                if si["audio"] is None:
                    self.err(f"segment {s['id']}: use_audio but source '{s['source']}' has no audio stream")
                    continue
                a_avail = si["audio"] - tin
                a_short = dur - min(a_avail, span if speed == 1.0 else a_avail)
                allowed = fr + (freeze if mode == "congelar" else 0.0)
                if a_short > allowed + 1e-6:
                    self.err(f"segment {s['id']}: source audio provides {a_avail:.3f}s but {dur:.3f}s are needed "
                             f"(shortfall {a_short:.3f}s); no implicit silence padding")
                    continue
                s["audio_pad_s"] = round(max(0.0, a_short), 6)

        # 3. narration must not be cut by the timeline end (editor mode)
        if self.narration and self.narration.get("source") in self.files:
            try:
                nd = media.stream_info(self.path_of(self.narration["source"]))["audio"] or 0.0
                end = float(self.narration.get("offset", 0.0)) + nd
                if end > self.total + fr + 1e-6:
                    self.err(f"narration ends at {end:.3f}s but the timeline is {self.total:.3f}s: it would be truncated")
            except Exception as e:
                self.err(f"narration: cannot probe: {str(e)[:200]}")
        self.media_resolved = True

    def _fixed_frames(self, s) -> int:
        if s.get("duration") not in (None, "auto"):
            return max(0, round(float(s["duration"]) * self.fps))
        if s["type"] in VIDEO_TYPES or s["type"] == "voice":
            if "out" in s:
                return round((float(s["out"]) - float(s.get("in", 0))) * self.fps)
            # until end of source (probed later once files are verified)
            fid = s.get("source")
            if fid in self.files:
                try:
                    d = media.duration(self.path_of(fid))
                    return round((d - float(s.get("in", 0))) * self.fps)
                except Exception:
                    self.err(f"segment {s['id']}: cannot probe source for implicit duration")
                    return 0
        self.err(f"segment {s['id']}: needs 'duration' (or in/out)")
        return 0

    # ---------------- verification of inputs
    def verify_files(self) -> list[dict]:
        results = []
        for fid, f in self.files.items():
            p = self.path_of(fid)
            r = {"id": fid, "path": f.get("path"), "role": f.get("role"), "ok": False}
            if not p.is_file():
                r["error"] = "missing"
            elif p.stat().st_size != int(f.get("size", -1)):
                r["error"] = f"size {p.stat().st_size} != manifest {f.get('size')}"
            else:
                sha = sha256_file(p)
                if sha != str(f.get("sha256", "")).lower():
                    r["error"] = f"sha256 mismatch (got {sha[:12]}..., manifest {str(f.get('sha256'))[:12]}...)"
                elif f.get("role") in NON_MEDIA_ROLES or p.suffix.lower() == ".json":
                    try:
                        json.loads(p.read_text(encoding="utf-8"))
                        r["ok"] = True
                    except Exception as e:
                        r["error"] = f"invalid JSON: {e}"
                else:
                    try:
                        pr = media.probe(p)
                        if not pr.get("streams"):
                            r["error"] = "ffprobe: no streams"
                        else:
                            r["ok"] = True
                            r["streams"] = [s.get("codec_type") for s in pr["streams"]]
                    except Exception as e:
                        r["error"] = f"ffprobe failed: {str(e)[:200]}"
            results.append(r)
        return results

    def verify_ready(self) -> tuple[bool, str]:
        rp = self.base / "LISTO.json"
        if not rp.is_file():
            return False, "LISTO.json missing (READY signal not present)"
        try:
            r = json.loads(rp.read_text(encoding="utf-8"))
        except Exception as e:
            return False, f"LISTO.json invalid: {e}"
        if r.get("manifest_sha256") != self.manifest_sha256:
            return False, "LISTO.json manifest_sha256 does not match montaje.json"
        if "file_count" in r and int(r["file_count"]) != len(self.files):
            return False, f"LISTO.json file_count {r['file_count']} != {len(self.files)}"
        return True, "ok"


# ---------------------------------------------------------------------------
# Lock + state
# ---------------------------------------------------------------------------

def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:  # guard against PID reuse by an unrelated process
        cmd = Path(f"/proc/{pid}/cmdline").read_bytes()
        return b"editor.py" in cmd
    except Exception:
        return True


class Lock:
    def __init__(self, path: Path, job_key: str):
        self.path, self.job_key, self.held = path, job_key, False

    def acquire(self):
        me = {"pid": os.getpid(), "host": socket.gethostname(), "job_key": self.job_key, "since": now()}
        for _ in range(2):
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
                with os.fdopen(fd, "w") as f:
                    json.dump(me, f)
                self.held = True
                return None
            except FileExistsError:
                try:
                    cur = json.loads(self.path.read_text())
                except Exception:
                    cur = {}
                pid, host = int(cur.get("pid", -1)), cur.get("host")
                if host and host != socket.gethostname():
                    raise Refused(f"locked by another host {host} pid {pid}; refusing (remove {self.path} manually if certain)")
                if pid > 0 and pid_alive(pid):
                    raise LockedError(f"locked by live process pid {pid} on {host} since {cur.get('since')}")
                log(f"stale lock (pid {pid} dead) -> taking over")
                stale = self.path.with_name(self.path.name + f".stale{pid}")
                try:
                    os.replace(self.path, stale)
                except FileNotFoundError:
                    pass
        raise LockedError("could not acquire lock")

    def release(self):
        if self.held:
            try:
                cur = json.loads(self.path.read_text())
                if cur.get("pid") == os.getpid():
                    self.path.unlink()
            except Exception:
                pass
            self.held = False


class LockedError(Exception):
    pass


# ---------------------------------------------------------------------------
# Chunk rendering
# ---------------------------------------------------------------------------

class Editor:
    def __init__(self, plan: Plan, work_root: Path, retries: int = 2):
        self.p = plan
        self.retries = retries
        self.work = (work_root / safe_name(plan.episode_id) / f"v{plan.version}").resolve()
        self.chunks_dir = self.work / "chunks"
        self.tmp = self.work / "tmp"
        self.out_dir = self.work / "salida"
        self.logs = self.work / "logs"
        for d in (self.chunks_dir, self.tmp, self.out_dir, self.logs):
            d.mkdir(parents=True, exist_ok=True)
        self.state_path = self.work / "state.json"
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        self.subs = None
        if plan.subs_cfg:
            self.subs = SubtitleTrack(plan.subs_cfg, plan.path_of(plan.subs_cfg["source"]))

    def save_state(self):
        self.state["updated_at"] = now()
        write_json(self.state_path, self.state)

    # ---- per-chunk instructions (everything that affects the pixels/samples of the chunk)
    def chunk_spec(self, s) -> dict:
        p = self.p
        spec = {k: v for k, v in s.items() if k not in ("index",)}
        spec["output"] = {k: p.out[k] for k in ("width", "height", "fps", "crf", "preset", "pix_fmt",
                                                 "sample_rate", "pad_color", "video_codec")}
        spec["ass"] = self.chunk_ass(s)
        for k in ("source", "background"):
            fid = s.get(k)
            if fid and fid in p.files:
                spec[f"{k}_sha256"] = p.files[fid]["sha256"]
        spec["avatar_default"] = (p.m.get("avatar") or {}).get("placement")
        return spec

    def chunk_key(self, s) -> str:
        return hashlib.sha256((EDITOR_VERSION + "|" + sjson(self.chunk_spec(s))).encode()).hexdigest()

    def chunk_ass(self, s) -> str | None:
        p = self.p
        start, end = s["start"], s["start"] + s["dur"]
        ev = []
        mode = (p.subs_cfg or {}).get("mode", "burn")
        if self.subs and mode == "burn":
            ev += self.subs.events(start, end)
        lab = [x for x in (s.get("label"), s.get("credit")) if x]
        if lab:
            style = (p.m.get("labels") or {}).get("style", "Source")
            ev.append(f"Dialogue: 1,0:00:00.00,{ass_time(s['dur'])},{style},,0,0,0,,{ass_escape(chr(10).join(lab))}")
        tc = p.m.get("title_card")
        if tc and tc.get("text"):
            a, z = max(start, float(tc["start"])), min(end, float(tc["end"]))
            if z > a:
                txt = ass_escape(tc["text"]) + (r"\N{\fs32}" + ass_escape(tc["subtitle"]) if tc.get("subtitle") else "")
                pos = tc.get("pos", [p.W // 2, round(p.H * 0.208)])
                ev.append(f"Dialogue: 2,{ass_time(a - start)},{ass_time(z - start)},Title,,0,0,0,,"
                          f"{{\\pos({pos[0]},{pos[1]})\\fad(500,700)}}{txt}")
        if s["type"] == "card":
            lines = s.get("lines") or []
            ev.append(f"Dialogue: 2,0:00:00.00,{ass_time(s['dur'])},{s.get('style', 'Title')},,0,0,0,,"
                      + r"\N".join(ass_escape(l) for l in lines))
        if not ev:
            return None
        return ass_header(p.W, p.H, (p.subs_cfg or {}).get("style")) + "\n".join(ev) + "\n"

    def _fit(self, mode: str, w: int | None = None, h: int | None = None) -> str:
        W, H = w or self.p.W, h or self.p.H
        c = self.p.out["pad_color"]
        if mode == "cover":
            return f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}"
        return f"scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color={c}"

    def _placement(self, s):
        pl = dict((self.p.m.get("avatar") or {}).get("placement") or {"mode": "full"})
        pl.update(s.get("placement") or {})
        return pl

    def build_chunk_cmd(self, s, out: Path, ass_path: Path | None) -> list[str]:
        p = self.p
        fps, W, H, N = p.fps, p.W, p.H, s["frames"]
        dur = s["dur"]
        nsamp = round(dur * p.sr)
        args, filt, idx = [], [], 0
        audio_in = None
        t = s["type"]
        fit = s.get("fit", "contain")

        def add_image(path):
            nonlocal idx
            args.extend(["-loop", "1", "-framerate", str(fps), "-i", str(path)])
            idx += 1
            return idx - 1

        def add_color():
            nonlocal idx
            args.extend(["-f", "lavfi", "-i", f"color=c={s.get('color', p.out['pad_color'])}:s={W}x{H}:r={fps}"])
            idx += 1
            return idx - 1

        # v2: no implicit freeze. Clone at most 1 frame (rounding) + the freeze the manifest
        # explicitly allowed (insuficiente 'congelar'), validated in Plan.resolve_media().
        if t in VIDEO_TYPES and "span" not in s:
            raise JobFailed(f"segment {s['id']}: media not resolved (internal error)")
        hold = float(s.get("congelar_s", 0.0)) + 1.0 / fps
        a_hold = float(s.get("audio_pad_s", 0.0)) + 1.0 / fps

        def add_video(path, span):
            nonlocal idx
            args.extend(["-ss", f"{s['in']:.3f}", "-t", f"{span:.6f}", "-i", str(path)])
            idx += 1
            return idx - 1

        def vid_chain(i, w=None, h=None):
            factor = 1.0 / float(s.get("velocidad", 1.0))  # setpts multiplier (>1 = slower)
            return (f"[{i}:v]setpts={factor:.6f}*(PTS-STARTPTS),{self._fit(fit, w, h)},setsar=1,fps={fps},"
                    f"tpad=stop_mode=clone:stop_duration={hold:.3f}")

        if t == "image":
            i = add_image(p.path_of(s["source"]))
            filt.append(f"[{i}:v]{self._fit(fit)},setsar=1,fps={fps}[v0]")
        elif t == "card":
            i = add_color()
            filt.append(f"[{i}:v]setsar=1[v0]")
        elif t in ("animation", "broll") or (t == "avatar" and self._placement(s).get("mode", "full") == "full"):
            i = add_video(p.path_of(s["source"]), s["span"])
            filt.append(vid_chain(i) + "[v0]")
            if s["use_audio"]:
                audio_in = i
        elif t == "avatar":  # picture-in-picture over a background
            pl = self._placement(s)
            bg = s.get("background", "color")
            b = add_color() if bg in (None, "color") else add_image(p.path_of(bg))
            a = add_video(p.path_of(s["source"]), s["span"])
            aw = int(pl.get("width", 480))
            aw -= aw % 2
            m = int(pl.get("margin", 48))
            corner = pl.get("corner", "bottom-right")
            x = pl.get("x", f"main_w-overlay_w-{m}" if "right" in corner else str(m))
            y = pl.get("y", f"main_h-overlay_h-{m}" if "bottom" in corner else str(m))
            filt.append(f"[{b}:v]{self._fit('cover') if bg not in (None, 'color') else 'null'},setsar=1,fps={fps}[bg]")
            filt.append(f"[{a}:v]setpts=PTS-STARTPTS,scale={aw}:-2,setsar=1,fps={fps},"
                        f"tpad=stop_mode=clone:stop_duration={hold:.3f}[av]")
            filt.append(f"[bg][av]overlay=x={x}:y={y}:eof_action=repeat[v0]")
            if s["use_audio"]:
                audio_in = a
        elif t == "voice":
            bg = s.get("background", "color")
            b = add_color() if bg in (None, "color") else add_image(p.path_of(bg))
            filt.append(f"[{b}:v]{self._fit(fit) if bg not in (None, 'color') else 'null'},setsar=1,fps={fps}[v0]")
            args.extend(["-ss", f"{s['in']:.3f}", "-t", f"{min(s['span'], dur):.6f}", "-i", str(p.path_of(s["source"]))])
            audio_in = idx
            idx += 1

        post = []
        if ass_path:
            post.append(f"ass=filename={ass_path}")
        ti, to = s.get("transition_in") or {}, s.get("transition_out") or {}
        if ti.get("type") == "fade":
            post.append(f"fade=t=in:st=0:d={float(ti.get('duration', 0.5)):.3f}:color={ti.get('color', 'black')}")
        if to.get("type") == "fade":
            d = float(to.get("duration", 0.5))
            post.append(f"fade=t=out:st={max(0, dur - d):.3f}:d={d:.3f}:color={to.get('color', 'black')}")
        post.append(f"format={p.out['pix_fmt']}")
        filt.append("[v0]" + ",".join(post) + "[v]")

        if audio_in is None:
            args.extend(["-f", "lavfi", "-i", f"anullsrc=r={p.sr}:cl=stereo"])
            audio_in = idx
            idx += 1
            achain = f"[{audio_in}:a]atrim=end_sample={nsamp}"
        else:
            achain = (f"[{audio_in}:a]asetpts=PTS-STARTPTS,aresample={p.sr},"
                      f"aformat=sample_fmts=s16:channel_layouts=stereo,apad=pad_dur={a_hold:.3f},atrim=end_sample={nsamp}")
            if ti.get("type") == "fade" and ti.get("audio", True):
                achain += f",afade=t=in:st=0:d={float(ti.get('duration', 0.5)):.3f}"
            if to.get("type") == "fade" and to.get("audio", True):
                d = float(to.get("duration", 0.5))
                achain += f",afade=t=out:st={max(0, dur - d):.3f}:d={d:.3f}"
        filt.append(achain + ",aformat=sample_fmts=s16:channel_layouts=stereo[a]")

        th = str(p.out.get("threads", 3))
        return args + ["-filter_complex", ";".join(filt), "-filter_threads", "1", "-map", "[v]", "-map", "[a]",
                       "-frames:v", str(N), "-fps_mode", "cfr", "-r", str(fps),
                       "-c:v", "libx264", "-preset", str(p.out["preset"]), "-crf", str(p.out["crf"]),
                       "-pix_fmt", p.out["pix_fmt"], "-g", str(fps * 2), "-threads", th,
                       "-c:a", "pcm_s16le", "-ar", str(p.sr), "-ac", "2", str(out)]

    def chunk_ok(self, path: Path, s) -> bool:
        try:
            if not path.is_file() or path.stat().st_size < 1000:
                return False
            si = media.stream_info(path)
            tol = 1.5 / self.p.fps
            return all(x is not None and abs(x - s["dur"]) <= tol for x in (si["video"], si["audio"]))
        except Exception:
            return False

    def render_chunks(self, no_cache: bool) -> dict:
        st = self.state.setdefault("chunks", {})
        stats = {"reused": [], "rendered": [], "invalidated": []}
        valid_ids = {s["id"] for s in self.p.segments}
        for sid in list(st):
            if sid not in valid_ids:
                self._drop_chunk(st.pop(sid))
                stats["invalidated"].append(sid)
        for s in self.p.segments:
            key = self.chunk_key(s)
            out = self.chunks_dir / f"chunk_{s['index']:04}_{safe_name(s['id'])}_{key[:12]}.mkv"
            cur = st.get(s["id"])
            if cur and cur.get("key") != key:
                log(f"chunk {s['id']}: instructions/inputs changed -> invalidated")
                self._drop_chunk(cur)
                stats["invalidated"].append(s["id"])
                cur = None
            if cur and cur.get("status") == "done" and not no_cache and self.chunk_ok(Path(cur["file"]), s):
                log(f"chunk {s['id']}: reused (key {key[:12]})")
                stats["reused"].append(s["id"])
                continue
            st[s["id"]] = {"key": key, "status": "rendering", "file": str(out), "attempts": 0,
                           "frames": s["frames"], "start": s["start"], "dur": s["dur"]}
            self.save_state()
            last_err = None
            for attempt in range(1, self.retries + 2):
                st[s["id"]]["attempts"] = attempt
                tmp = self.tmp / f"{out.stem}.part{os.getpid()}.mkv"
                try:
                    if os.environ.get("PODCAST_EDITOR_FAIL_SEGMENT") == s["id"]:  # test hook
                        raise FFError("simulated failure (PODCAST_EDITOR_FAIL_SEGMENT)")
                    ass = self.p_ass(s, key)
                    t0 = time.time()
                    ffmpeg(self.build_chunk_cmd(s, tmp, ass), self.logs / "ffmpeg.log")
                    if not self.chunk_ok(tmp, s):
                        raise FFError(f"chunk {s['id']} duration check failed")
                    os.replace(tmp, out)
                    st[s["id"]].update(status="done", render_s=round(time.time() - t0, 2), rendered_at=now())
                    self.save_state()
                    log(f"chunk {s['id']}: rendered {s['dur']:.2f}s in {time.time() - t0:.1f}s (attempt {attempt})")
                    stats["rendered"].append(s["id"])
                    last_err = None
                    break
                except FFError as e:
                    last_err = str(e)
                    tmp.unlink(missing_ok=True)
                    log(f"chunk {s['id']}: attempt {attempt} failed: {last_err[:300]}")
            if last_err:
                st[s["id"]].update(status="failed", error=last_err[:2000])
                self.save_state()
                raise JobFailed(f"chunk {s['id']} failed after {self.retries + 1} attempts: {last_err[:500]}")
        return stats

    def p_ass(self, s, key) -> Path | None:
        txt = self.chunk_ass(s)
        if not txt:
            return None
        path = self.tmp / f"chunk_{s['index']:04}_{key[:12]}.ass"
        path.write_text(txt, encoding="utf-8")
        return path

    def _drop_chunk(self, rec):
        try:
            Path(rec.get("file", "")).unlink(missing_ok=True)
        except Exception:
            pass

    # ---------------- assembly
    def assemble(self) -> dict:
        if self.p.premixed:
            return self.assemble_premixed()
        p, T, sr = self.p, self.tmp, self.p.sr
        L = self.logs / "ffmpeg.log"
        N = p.total_samples
        lst = T / "concat.txt"
        lst.write_text("".join(f"file '{self.state['chunks'][s['id']]['file']}'\n" for s in p.segments))
        video = T / "video.mkv"
        speech_chunks = T / "chunks_audio.wav"
        log("concat (demuxer, stream copy)")
        ffmpeg(["-f", "concat", "-safe", "0", "-i", str(lst), "-map", "0:v", "-c", "copy", str(video),
                "-map", "0:a", "-c:a", "pcm_s16le", str(speech_chunks)], L)

        speech = speech_chunks
        if p.narration:
            n = p.narration
            ln = n.get("loudnorm") or {"integrated": -16, "true_peak": -1.5, "lra": 8}  # mix.py voice target
            off = float(n.get("offset", 0.0))
            narr = T / "narration.wav"
            log("narration: loudnorm + place")
            af = []
            if ln:
                af.append(f"loudnorm=I={ln['integrated']}:TP={ln['true_peak']}:LRA={ln['lra']}")
            af += [f"aresample={sr}", "aformat=sample_fmts=s16:channel_layouts=stereo",
                   f"adelay={round(off * 1000)}:all=1", "apad", f"atrim=end_sample={N}"]
            ffmpeg(["-i", str(p.path_of(n["source"])), "-af", ",".join(af), "-c:a", "pcm_s16le", str(narr)], L)
            speech = T / "speech.wav"
            ffmpeg(["-i", str(speech_chunks), "-i", str(narr), "-filter_complex",
                    f"[0:a][1:a]amix=inputs=2:normalize=0:duration=longest,atrim=end_sample={N}",
                    "-c:a", "pcm_s16le", str(speech)], L)

        mix_in = speech
        cues = p.music.get("cues") or []
        if cues:
            log(f"music: {len(cues)} cue(s), ducking={p.ducking['mode']}")
            mln = p.music.get("loudnorm", {"integrated": -27, "true_peak": -4, "lra": 7})  # mix.py music target
            cue_files = []
            for k, c in enumerate(cues):
                a, z = float(c["start"]), min(float(c["end"]), p.total)
                d = z - a
                fi, fo = float(c.get("fade_in", 2.0)), float(c.get("fade_out", 2.0))
                af = [f"atrim=0:{d:.3f}"]
                if mln:
                    af.append(f"loudnorm=I={mln['integrated']}:TP={mln['true_peak']}:LRA={mln['lra']}")
                af += [f"aresample={sr}", "aformat=sample_fmts=s16:channel_layouts=stereo",
                       f"afade=t=in:st=0:d={min(fi, d / 2):.3f}", f"afade=t=out:st={max(0, d - fo):.3f}:d={min(fo, d / 2):.3f}",
                       f"volume={float(c.get('volume_db', 0))}dB", f"adelay={round(a * 1000)}:all=1", "apad", f"atrim=end_sample={N}"]
                cf = T / f"music_{k:02}.wav"
                inp = (["-stream_loop", "-1"] if c.get("loop", True) else []) + ["-i", str(p.path_of(c["source"]))]
                ffmpeg(inp + ["-af", ",".join(af), "-c:a", "pcm_s16le", str(cf)], L)
                cue_files.append(cf)
            bed = T / "music_bed.wav"
            if len(cue_files) == 1:
                shutil.copyfile(cue_files[0], bed)
            else:
                ins = sum((["-i", str(f)] for f in cue_files), [])
                ffmpeg(ins + ["-filter_complex", "".join(f"[{i}:a]" for i in range(len(cue_files)))
                              + f"amix=inputs={len(cue_files)}:normalize=0,atrim=end_sample={N}",
                              "-c:a", "pcm_s16le", str(bed)], L)
            ducked = bed
            if p.ducking.get("mode") == "envelope":
                env = self.duck_envelope(speech)
                ducked = T / "music_ducked.wav"
                ffmpeg(["-i", str(bed), "-i", str(env), "-filter_complex",
                        f"[1:a]aresample={sr},pan=stereo|c0=c0|c1=c0,apad[e];[0:a][e]amultiply,"
                        f"atrim=end_sample={N},aformat=sample_fmts=s16:channel_layouts=stereo",
                        "-c:a", "pcm_s16le", str(ducked)], L)
            elif p.ducking.get("mode") == "sidechain":
                ducked = T / "music_ducked.wav"
                ffmpeg(["-i", str(bed), "-i", str(speech), "-filter_complex",
                        "[0:a][1:a]sidechaincompress=threshold=0.03:ratio=4:attack=20:release=400,"
                        f"atrim=end_sample={N}", "-c:a", "pcm_s16le", str(ducked)], L)
            mix_in = T / "mix.wav"
            ffmpeg(["-i", str(speech), "-i", str(ducked), "-filter_complex",
                    f"[0:a][1:a]amix=inputs=2:normalize=0:duration=longest,atrim=end_sample={N}",
                    "-c:a", "pcm_s24le", str(mix_in)], L)

        # final loudness: two-pass loudnorm (linear) -> target
        lt = p.out["loudness"]
        log("final loudness (2-pass loudnorm)")
        meas = self._loudnorm_measure(mix_in, lt)
        final = T / "final.wav"
        lnf = (f"loudnorm=I={lt['integrated']}:TP={lt['true_peak']}:LRA={lt['lra']}:"
               f"measured_I={meas['input_i']}:measured_TP={meas['input_tp']}:measured_LRA={meas['input_lra']}:"
               f"measured_thresh={meas['input_thresh']}:offset={meas['target_offset']}:linear=true,")
        try:
            silent = float(meas["input_i"]) <= -70
        except ValueError:
            silent = True
        if silent:  # all-silent mix (e.g. video-only test episode): loudnorm cannot measure it
            log("final mix is silent: loudnorm skipped")
            lnf = ""
        ffmpeg(["-i", str(mix_in), "-af", f"{lnf}aresample={sr},aformat=sample_fmts=s16:channel_layouts=stereo,"
                f"apad,atrim=end_sample={N}", "-c:a", "pcm_s16le", str(final)], L)

        srt, meta = self._srt_and_meta()
        mp4 = self.out_dir / "episodio.mp4"
        tmp4 = T / "episodio.part.mp4"
        log("export mp4")
        a = ["-i", str(video), "-i", str(final), "-i", str(meta)]
        maps = ["-map", "0:v", "-map", "1:a", "-map_metadata", "2", "-map_chapters", "2"]
        a, maps = self._mux_subs(a, maps, srt, 3)
        ffmpeg(a + maps + ["-c:v", "copy", "-c:a", "aac", "-b:a", p.out["audio_bitrate"], "-ar", str(sr),
                           "-t", f"{p.total:.6f}", "-movflags", "+faststart", str(tmp4)], L)
        os.replace(tmp4, mp4)
        mp3 = self.out_dir / "episodio.mp3"
        tmp3 = T / "episodio.part.mp3"
        log("export mp3")
        ffmpeg(["-i", str(final), "-i", str(meta), "-map", "0:a", "-map_metadata", "1", "-map_chapters", "1",
                "-c:a", "libmp3lame", "-b:a", p.out["mp3_bitrate"], "-id3v2_version", "3", str(tmp3)], L)
        os.replace(tmp3, mp3)
        self._credits()
        return {"mp4": str(mp4), "mp3": str(mp3), "srt": str(srt) if srt else None, "loudnorm_input": meas}

    def assemble_premixed(self) -> dict:
        """audio.modo 'mezcla_final': the delivered mix is carried untouched. No music, no ducking,
        no loudnorm, no resampling, no -t/-shortest. MP4: AAC stream copied if the source is AAC,
        otherwise encoded to AAC once (only at the final mux). MP3: copied if the source is MP3,
        otherwise encoded once with libmp3lame (no filters)."""
        p, T = self.p, self.tmp
        L = self.logs / "ffmpeg.log"
        lst = T / "concat.txt"
        lst.write_text("".join(f"file '{self.state['chunks'][s['id']]['file']}'\n" for s in p.segments))
        video = T / "video.mkv"
        log("concat video (demuxer, stream copy) - premixed audio mode")
        ffmpeg(["-f", "concat", "-safe", "0", "-i", str(lst), "-map", "0:v", "-c", "copy", str(video)], L)
        src = p.path_of(p.audio["source"])
        codec = p.premix["codec"]
        srt, meta = self._srt_and_meta()
        mp4 = self.out_dir / "episodio.mp4"
        tmp4 = T / "episodio.part.mp4"
        a = ["-i", str(video), "-i", str(src), "-i", str(meta)]
        maps = ["-map", "0:v:0", "-map", "1:a:0", "-map_metadata", "2", "-map_chapters", "2"]
        a, maps = self._mux_subs(a, maps, srt, 3)
        acodec = ["-c:a", "copy"] if codec == "aac" else ["-c:a", "aac", "-b:a", p.out["audio_bitrate"]]
        log(f"export mp4 (audio {'stream copy' if codec == 'aac' else 'AAC encode, no filters'})")
        ffmpeg(a + maps + ["-c:v", "copy", *acodec, "-movflags", "+faststart", str(tmp4)], L)
        os.replace(tmp4, mp4)
        mp3 = self.out_dir / "episodio.mp3"
        tmp3 = T / "episodio.part.mp3"
        m3codec = ["-c:a", "copy"] if codec == "mp3" else ["-c:a", "libmp3lame", "-b:a", p.out["mp3_bitrate"]]
        log(f"export mp3 ({'stream copy' if codec == 'mp3' else 'libmp3lame from source, no filters'})")
        ffmpeg(["-i", str(src), "-i", str(meta), "-map", "0:a:0", "-map_metadata", "1", "-map_chapters", "1",
                *m3codec, "-id3v2_version", "3", str(tmp3)], L)
        os.replace(tmp3, mp3)
        self._credits()
        return {"mp4": str(mp4), "mp3": str(mp3), "srt": str(srt) if srt else None,
                "audio_carry": {"source_codec": codec, "mp4": acodec[1], "mp3": m3codec[1]}}

    def _mux_subs(self, a, maps, srt, idx):
        p = self.p
        if srt and (p.subs_cfg or {}).get("mode") == "mux":
            a = a + ["-i", str(srt)]
            maps = maps + ["-map", f"{idx}:s", "-c:s", "mov_text", "-metadata:s:s:0",
                           f"language={(p.subs_cfg or {}).get('language', 'spa')}"]
        return a, maps

    def _srt_and_meta(self):
        p, T = self.p, self.tmp
        srt = None
        if self.subs:
            srt = self.out_dir / "episodio.srt"
            srt.write_text(self.subs.to_srt(), encoding="utf-8")
        meta = T / "ffmeta.txt"
        md = p.out.get("metadata") or {}
        lines = [";FFMETADATA1"] + [f"{k}={str(v).replace(chr(10), ' ')}" for k, v in md.items()]
        for c in p.chapters:
            if "start" in c and "end" in c:
                lines += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={round(float(c['start']) * 1000)}",
                          f"END={round(float(c['end']) * 1000)}", f"title={c.get('title', c['id'])}"]
        meta.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return srt, meta

    def _credits(self):
        p = self.p
        credits = p.m.get("sources_credits") or {}
        seg_credits = [{"segment": s["id"], "start": round(s["start"], 3), "credit": s["credit"]}
                       for s in p.segments if s.get("credit")]
        write_json(self.out_dir / "creditos.json", {"sources": credits.get("sources", []), "per_segment": seg_credits})
        if p.chapters:
            write_json(self.out_dir / "capitulos.json", p.chapters)

    def _loudnorm_measure(self, path: Path, lt) -> dict:
        import subprocess
        r = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-i", str(path), "-af",
                            f"loudnorm=I={lt['integrated']}:TP={lt['true_peak']}:LRA={lt['lra']}:print_format=json",
                            "-f", "null", "-"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, preexec_fn=media._die_with_parent)
        txt = r.stderr.decode(errors="replace")
        j = txt[txt.rfind("{"): txt.rfind("}") + 1]
        if r.returncode or not j:
            raise FFError("loudnorm measure failed: " + txt[-800:])
        return json.loads(j)

    def duck_envelope(self, speech: Path) -> Path:
        """Port of mix.py ducking (20 ms windows, gain->duck_gain when voice RMS > threshold,
        fast attack / slow release) but streaming: RMS per window comes from ffmpeg astats,
        gains are written as a 1 kHz envelope and multiplied in ffmpeg (no full-file arrays in RAM)."""
        import array
        import math as _m
        import struct
        import wave
        d = self.p.ducking
        win = int(d["window_ms"])
        nper = round(self.p.sr * win / 1000)
        rms_txt = self.tmp / "speech_rms.txt"
        rms_txt.unlink(missing_ok=True)
        ffmpeg(["-i", str(speech), "-af",
                f"aformat=channel_layouts=mono,asetnsamples=n={nper}:p=0,astats=metadata=1:reset=1:measure_overall=RMS_level:measure_perchannel=none,"
                f"ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file={rms_txt}", "-f", "null", "-"],
               self.logs / "ffmpeg.log")
        thr, duck, att, rel = float(d["threshold_rms"]), float(d["duck_gain"]), float(d["attack"]), float(d["release"])
        env = self.tmp / "duck_env.wav"
        gain = 1.0
        nwin = 0
        with open(rms_txt) as f, wave.open(str(env), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(1000)
            buf = array.array("h")
            for line in f:
                if "RMS_level=" not in line:
                    continue
                v = line.strip().split("=", 1)[1]
                try:
                    rms = 10 ** (float(v) / 20) if v not in ("-inf", "inf", "nan") else 0.0
                except ValueError:
                    rms = 0.0
                if not _m.isfinite(rms):
                    rms = 0.0
                target = duck if rms > thr else 1.0
                gain += (target - gain) * (att if target < gain else rel)
                buf.extend([int(gain * 32767)] * win)
                nwin += 1
                if len(buf) > 100000:
                    w.writeframes(buf.tobytes())
                    buf = array.array("h")
            w.writeframes(buf.tobytes())
        self.state["ducking_windows"] = nwin
        return env

    # ---------------- verification
    def verify(self, outs: dict) -> dict:
        p = self.p
        mp4, mp3 = Path(outs["mp4"]), Path(outs["mp3"])
        res = {"checks": [], "ok": True}

        def check(name, ok, detail):
            res["checks"].append({"check": name, "ok": bool(ok), "detail": detail})
            if not ok:
                res["ok"] = False

        tol = max(0.1, 2.0 / p.fps)
        pr = media.probe(mp4)
        vs = [s for s in pr["streams"] if s["codec_type"] == "video"]
        aus = [s for s in pr["streams"] if s["codec_type"] == "audio"]
        check("video_stream", len(vs) == 1 and vs[0]["codec_name"] == "h264", vs[0]["codec_name"] if vs else None)
        check("audio_stream_present", len(aus) == 1 and aus[0]["codec_name"] == "aac", aus[0]["codec_name"] if aus else None)
        vd = None
        if vs:
            v = vs[0]
            check("resolution", (v["width"], v["height"]) == (p.W, p.H), f"{v['width']}x{v['height']}")
            fr = media.fraction(v.get("avg_frame_rate", "0/1"))
            check("fps", abs(fr - p.fps) < 0.01, fr)
            vd = float(v.get("duration", pr["format"]["duration"]))
            check("video_vs_expected", abs(vd - p.total) <= tol, {"video": vd, "expected": p.total, "tol": tol})
        if aus and not p.premixed:
            ad = float(aus[0].get("duration", 0))
            check("audio_vs_expected", abs(ad - p.total) <= tol, {"audio": ad, "expected": p.total})
            if vs:
                check("video_vs_audio", abs(vd - ad) <= tol, {"diff": round(vd - ad, 4)})
        if p.premixed:
            self._verify_premixed(mp4, mp3, check, vs, pr)
        else:
            m3 = media.probe(mp3)
            d3 = float(m3["format"]["duration"])
            check("mp3_duration", abs(d3 - p.total) <= tol, {"mp3": d3, "expected": p.total})
        if self.subs:
            cues = sorted(self.subs.cues, key=lambda c: c["start"])
            ad = float(aus[0]["duration"]) if aus else p.total
            bad_range = [i for i, c in enumerate(cues) if not (0 <= c["start"] < c["end"] <= ad + 0.001)]
            overl = [i for i, (a, b) in enumerate(zip(cues, cues[1:])) if b["start"] < a["end"] - 0.001]
            check("subtitles_within_audio", not bad_range, {"cues": len(cues), "out_of_range": bad_range[:10]})
            check("subtitles_no_overlap", not overl, {"overlaps_at": overl[:10]})
        t0 = time.time()
        e = media.decode_errors(mp4)
        check("full_decode_mp4", e == "", {"errors": e[:500], "seconds": round(time.time() - t0, 1)})
        e3 = media.decode_errors(mp3)
        check("full_decode_mp3", e3 == "", {"errors": e3[:500]})
        return res

    def _verify_premixed(self, mp4: Path, mp3: Path, check, vs, pr):
        """Premixed audio must arrive complete and untouched (within lossy-codec tolerance)."""
        p = self.p
        fr = 1.0 / p.fps
        src = p.path_of(p.audio["source"])
        S = p.premix  # decoded source stats (sample count at the source rate)
        A = S["duration"]
        for name, f in (("mp4", mp4), ("mp3", mp3)):
            o = media.audio_stats(f)
            check(f"premix_{name}_duration_vs_source", abs(o["duration"] - A) <= fr,
                  {"source_s": round(A, 6), "out_s": round(o["duration"], 6), "diff_s": round(o["duration"] - A, 6),
                   "tol_s": fr, "source_samples": S["samples"], "out_samples": o["samples"],
                   "sample_rate": [S["sample_rate"], o["sample_rate"]]})
            check(f"premix_{name}_level_unchanged", abs(o["rms_db"] - S["rms_db"]) <= 0.5,
                  {"source_rms_db": round(S["rms_db"], 2), "out_rms_db": round(o["rms_db"], 2),
                   "note": "no loudnorm/ducking/music: global RMS must match within 0.5 dB"})
            t = media.compare_tail(src, f, A)
            check(f"premix_{name}_ending_not_truncated", t["ok"], t)
        if vs:
            v = vs[0]
            vd = float(v.get("duration", pr["format"]["duration"]))
            check("premix_video_vs_audio", abs(vd - A) <= fr + 1e-6,
                  {"video_s": round(vd, 6), "audio_s": round(A, 6), "diff_s": round(vd - A, 6), "tol_s": fr,
                   "rule": p.audio.get("timeline", "exacto")})

    def samples(self, mp4: Path, n: int = 12) -> dict:
        d = self.out_dir / "muestras"
        if d.exists():
            shutil.rmtree(d)
        d.mkdir()
        tot = self.p.total
        frames = []
        for i in range(n):
            t = tot * (i + 0.5) / n
            f = d / f"muestra_{i + 1:02}_{t:07.2f}s.jpg"
            ffmpeg(["-ss", f"{t:.3f}", "-i", str(mp4), "-frames:v", "1", "-q:v", "3", str(f)])
            frames.append(f)
        cols = 4
        rows = math.ceil(n / cols)
        lst = d / "_lista.txt"
        lst.write_text("".join(f"file '{f}'\n" for f in frames))
        ffmpeg(["-f", "concat", "-safe", "0", "-i", str(lst), "-vf",
                f"scale=480:-2,tile={cols}x{rows}:padding=4:color=black", "-frames:v", "1", "-q:v", "3",
                str(d / "hoja_contactos.jpg")])
        lst.unlink()
        return {"dir": str(d), "frames": [f.name for f in frames], "contact_sheet": "hoja_contactos.jpg"}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def print_plan(p: Plan, file_results, ready):
    print(f"Episode {p.episode_id} v{p.version}  manifest sha256 {p.manifest_sha256}")
    print(f"Job key {p.job_key[:16]}...  editor {EDITOR_VERSION}")
    print(f"Output {p.W}x{p.H}@{p.fps} H.264/AAC {p.sr} Hz, loudness {p.out['loudness']}")
    print(f"READY: {ready[0]} ({ready[1]})")
    print("Files:")
    for r in file_results:
        print(f"  {'OK ' if r['ok'] else 'BAD'} {r['id']:<14} {r['role']:<16} {r['path']}  {r.get('error', '')}")
    print(f"Timeline ({len(p.segments)} segments, {p.total:.3f}s = {p.total_frames} frames):")
    for s in p.segments:
        print(f"  {s['index']:>3} {s['id']:<10} {s['type']:<9} {s['start']:8.3f} +{s['dur']:7.3f}s "
              f"src={s.get('source', '-')} in={s.get('in', '-')} label={s.get('label', '')!r} credit={s.get('credit', '')!r}")
    for k, c in enumerate(p.music.get("cues") or []):
        print(f"  music {k}: {c['source']} {c['start']}-{c['end']}s vol {c.get('volume_db', 0)}dB loop={c.get('loop', True)}")
    print(f"  ducking: {p.ducking}")
    if p.subs_cfg:
        print(f"  subtitles: {p.subs_cfg.get('source')} format={p.subs_cfg.get('format', 'srt')} mode={p.subs_cfg.get('mode', 'burn')}")
    for w in p.warnings:
        print("WARNING:", w)
    for e in p.errors:
        print("ERROR:", e)


def cmd_run(a) -> int:
    t_start = time.time()
    try:
        plan = Plan(Path(a.manifest))
    except Refused as e:
        print("REFUSED:", e)
        return 1
    files = plan.verify_files() if not plan.errors or plan.files else []
    ready = plan.verify_ready()
    bad = [r for r in files if not r["ok"]]
    if files and not bad:
        plan.resolve_media()  # v2: premixed audio length + footage sufficiency (no implicit freeze)
    if a.dry_run:
        print_plan(plan, files, ready)
        ok = not plan.errors and not bad and ready[0]
        print("DRY-RUN:", "VALID - would render" if ok else "INVALID - would refuse")
        return 0 if ok else 1
    reasons = list(plan.errors) + [f"file {r['id']}: {r.get('error')}" for r in bad]
    if not ready[0]:
        reasons.append(ready[1])
    work_root = Path(a.work).resolve()
    if reasons:
        print("REFUSED (nothing rendered):")
        for r in reasons:
            print("  -", r)
        if plan.version and plan.episode_id:
            ed_dir = work_root / safe_name(plan.episode_id) / f"v{plan.version}"
            ed_dir.mkdir(parents=True, exist_ok=True)
            write_json(ed_dir / "rechazo.json", {"status": "refused", "at": now(), "manifest_sha256": plan.manifest_sha256,
                                                 "reasons": reasons})
        return 1

    ed = Editor(plan, work_root, retries=a.retries)
    lock = Lock(ed.work / ".lock", plan.job_key)
    try:
        lock.acquire()
    except LockedError as e:
        print("LOCKED:", e)
        return 3
    except Refused as e:
        print("REFUSED:", e)
        return 1
    report = {"editor_version": EDITOR_VERSION, "episode_id": plan.episode_id, "assembly_version": plan.version,
              "manifest_sha256": plan.manifest_sha256, "job_key": plan.job_key, "started_at": now(),
              "host": socket.gethostname(), "pid": os.getpid()}
    try:
        st = ed.state
        if st.get("status") == "done" and st.get("job_key") == plan.job_key and not a.force \
                and (ed.out_dir / "episodio.mp4").exists():
            print(f"ALREADY DONE: job {plan.job_key[:16]} completed at {st.get('finished_at')} (use --force to rerun)")
            return 0
        if st.get("job_key") and st.get("job_key") != plan.job_key:
            log("manifest changed since last job for this version -> chunk keys decide what is reused")
            st.setdefault("history", []).append({"job_key": st.get("job_key"), "status": st.get("status"),
                                                 "manifest_sha256": st.get("manifest_sha256")})
        st.update(job_key=plan.job_key, manifest_sha256=plan.manifest_sha256, editor_version=EDITOR_VERSION,
                  status="running", started_at=now(), pid=os.getpid(), error=None)
        ed.save_state()
        log(f"job {plan.job_key[:16]}: {len(plan.segments)} segments, {plan.total:.2f}s")
        t0 = time.time()
        stats = ed.render_chunks(a.no_cache)
        report["chunks"] = stats
        report["chunks_seconds"] = round(time.time() - t0, 2)
        t1 = time.time()
        outs = ed.assemble()
        report["assemble_seconds"] = round(time.time() - t1, 2)
        t2 = time.time()
        ver = ed.verify(outs)
        report["verification"] = ver
        report["verify_seconds"] = round(time.time() - t2, 2)
        report["outputs"] = {k: v for k, v in outs.items() if k != "loudnorm_input"}
        for k in ("mp4", "mp3"):
            pth = Path(outs[k])
            report["outputs"][k + "_size"] = pth.stat().st_size
            report["outputs"][k + "_sha256"] = sha256_file(pth)
        report["samples"] = ed.samples(Path(outs["mp4"]))
        if not ver["ok"]:
            raise JobFailed("verification failed: " + ", ".join(c["check"] for c in ver["checks"] if not c["ok"]))
        st.update(status="done", finished_at=now())
        report["status"] = "done"
        if not a.keep_tmp:  # big intermediates; chunks are kept as the resume cache
            for f in ed.tmp.glob("*"):
                if f.suffix in (".wav", ".mkv") or f.name.endswith(".txt"):
                    f.unlink(missing_ok=True)
        ed.save_state()
        return 0
    except (JobFailed, FFError) as e:
        ed.state.update(status="failed", error=str(e)[:2000], finished_at=now())
        ed.save_state()
        report["status"] = "failed"
        report["error"] = str(e)[:4000]
        print("FAILED:", str(e)[:1000])
        return 2
    finally:
        if "status" in report:
            report["finished_at"] = now()
            report["wall_seconds"] = round(time.time() - t_start, 2)
            write_json(ed.out_dir / "reporte.json", report)
            print(f"report: {ed.out_dir / 'reporte.json'}  status={report['status']}")
        lock.release()


def _backend(a, work: Path | None = None):
    if a.backend == "local":
        return stg.LocalBackend(a.root)
    from podcast_editor.supabase_backend import SupabaseBackend
    return SupabaseBackend.from_env(state_dir=(work / "transferencias") if work else None)


def cmd_publish(a) -> int:
    """Insert outputs (idempotent, never overwrite) -> verify each -> write salida/COMPLETO.json LAST."""
    plan = Plan(Path(a.manifest))
    work = Path(a.work).resolve() / safe_name(plan.episode_id) / f"v{plan.version}"
    stp = work / "state.json"
    st = json.loads(stp.read_text()) if stp.exists() else {}
    if st.get("status") != "done" or st.get("job_key") != plan.job_key:
        print("REFUSED: job not done for this manifest")
        return 1
    rep = work / "salida" / "reporte.json"
    rj = json.loads(rep.read_text())
    if rj.get("status") != "done" or not rj.get("verification", {}).get("ok"):
        print("REFUSED: reporte.json is not a verified, finished job")
        return 1
    try:
        be = _backend(a, work)
        pre = episode_prefix(plan.episode_id, plan.version)
        res = stg.publish(be, pre, work / "salida", {f"reporte-{plan.job_key[:12]}.json": rep}, work / "tmp",
                          {"episode_id": plan.episode_id, "assembly_version": plan.version,
                           "editor_version": EDITOR_VERSION, "job_key": plan.job_key,
                           "manifest_sha256": plan.manifest_sha256}, verify_mode=a.verificacion, log=log)
    except stg.ConflictError as e:
        print("CONFLICT (nothing overwritten, no completion marker):", e)
        return 5
    except stg.StorageError as e:
        print("FAILED (no completion marker):", e)
        return 2
    write_json(work / "publicado.json", {"backend": a.backend, "at": now(), "prefix": pre, **res})
    n_up = sum(1 for o in res["objects"] if o["action"] == "uploaded")
    print(f"published {len(res['objects'])} objects ({n_up} uploaded, {len(res['objects']) - n_up} reused), "
          f"all verified ({a.verificacion}); marker {res['marker']} {res['marker_action']}")
    return 0


def cmd_fetch(a) -> int:
    """Wait for entrada/LISTO.json, download every file and verify sha256 before any edit."""
    dest = Path(a.dest).resolve()
    try:
        be = _backend(a, dest)
        mp = stg.fetch_inputs(be, a.episode, a.version, dest, wait_s=a.esperar, poll_s=a.intervalo, log=log)
    except stg.NotReadyError as e:
        print("NOT READY:", e)
        return 4
    except stg.InputRefused as e:
        print("REFUSED (input):", e)
        return 1
    except stg.StorageError as e:
        print("FAILED:", e)
        return 2
    print(f"inputs verified; manifest: {mp}")
    return 0


def cmd_sign(a) -> int:
    plan = Plan(Path(a.manifest))
    pre = episode_prefix(plan.episode_id, plan.version)
    be = _backend(a)
    if be.read_bytes(f"{pre}/salida/{stg.MARKER_NAME}") is None:
        print(f"REFUSED: {pre}/salida/{stg.MARKER_NAME} not present (publication incomplete)")
        return 1
    out = {k: be.signed_url(f"{pre}/salida/{k}", a.expira) for k in a.objetos}
    print(json.dumps({"expires_in": a.expira, "urls": out}, indent=2))
    return 0


def cmd_validate(a) -> int:
    """Schema + semantic validation of a montaje.json; with --archivos also files, LISTO.json and media rules."""
    mp = Path(a.manifest)
    res = {"manifest": str(mp), "schema_errors": [], "errors": [], "warnings": [], "files": None}
    try:
        obj = json.loads(mp.read_bytes())
    except (OSError, ValueError) as e:
        res["errors"].append(f"cannot read JSON: {e}")
        obj = None
    if obj is not None:
        res["schema_errors"] = validate_manifest(obj)
        try:
            plan = Plan(mp)
            if a.archivos:
                files = plan.verify_files()
                res["files"] = files
                bad = [r for r in files if not r["ok"]]
                for r in bad:
                    plan.err(f"file {r['id']}: {r.get('error')}")
                ok, why = plan.verify_ready()
                if not ok:
                    plan.err(why)
                if not bad:
                    plan.resolve_media()
                res["total_seconds"] = round(plan.total, 3)
                res["segments"] = len(plan.segments)
            res["errors"] += plan.errors
            res["warnings"] += plan.warnings
        except Refused as e:
            res["errors"].append(str(e))
    res["valid"] = not res["schema_errors"] and not res["errors"]
    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    else:
        for e in res["schema_errors"]:
            print("SCHEMA:", e)
        for e in res["errors"]:
            print("ERROR:", e)
        for w in res["warnings"]:
            print("WARNING:", w)
        print("VALID" if res["valid"] else "INVALID", "(" + ("schema+semantics+files/media" if a.archivos
                                                          else "schema+semantics; use --archivos for files/media") + ")")
    return 0 if res["valid"] else 1


def cmd_check(a) -> int:
    """Non-destructive connection check: login, assignments, list entrada/, optional insert-only estado probe.
    Never prints the password, tokens or the e-mail."""
    rep = {"at": now(), "editor_version": EDITOR_VERSION, "backend": a.backend, "pasos": []}

    def step(name, ok, detail=""):
        rep["pasos"].append({"paso": name, "ok": ok, "detalle": detail})
        print(f"[{'OK' if ok else 'FALLO' if ok is False else '--'}] {name}: {detail}")
        return ok

    try:
        be = _backend(a)
    except stg.StorageError as e:
        step("configuracion", False, str(e))
        return _check_end(a, rep, 2)
    if a.backend == "supabase":
        host = urllib.parse.urlparse(be.url).netloc
        step("configuracion", True, f"url={host} bucket={be.bucket} (credenciales cargadas, no se muestran)")
        try:
            be.session.login()
            uid = _jwt_sub(be.session._access)
            step("login", True, f"usuario {uid} (rol authenticated), token caduca en "
                                f"{int(be.session.expires_at - time.time())} s")
        except stg.StorageError as e:
            step("login", False, str(e))
            return _check_end(a, rep, 2)
        asig = be.list_assignments()
    else:
        step("configuracion", True, f"backend local en {a.root}")
        asig = {"fuente": "no aplica (backend local)", "filas": None}
    filas = asig.get("filas")
    if filas is not None:
        vig = [f for f in filas if not f.get("revoked") and f.get("expires_at", "") > dt.datetime.now(
            dt.timezone.utc).isoformat()]
        step("asignaciones", bool(vig), f"{len(vig)} vigente(s) de {len(filas)} (fuente: {asig['fuente']})")
        targets = [(f["episode_id"], int(f["version"]), f.get("permisos", [])) for f in vig]
    else:
        step("asignaciones", None, asig.get("fuente", "") + "; se usan --episode/--version o el listado del bucket")
        targets = []
    if a.episode:
        targets = [t for t in targets if t[0] == a.episode and (a.version is None or t[1] == a.version)] or \
                  [(a.episode, a.version or 1, None)]
    if not targets:
        try:
            eps = sorted({o.key.split("/")[1] for o in _walk(be, "episodios", 3)})
        except stg.StorageError as e:
            eps = []
            step("listado bucket", False, str(e))
        step("prefijos visibles", bool(eps), ", ".join(eps) or "ninguno (sin asignación vigente o bucket vacío)")
        targets = []
        for ep in eps:
            vers = sorted({o.key.split("/")[2] for o in _walk(be, f"episodios/{ep}", 2)})
            targets += [(ep, int(v[1:]), None) for v in vers if re.fullmatch(r"v[1-9][0-9]*", v)]
    rep["prefijos"] = [episode_prefix(e, v) for e, v, _ in targets]
    worst = 0
    for ep, ver, perms in targets:
        pre = episode_prefix(ep, ver)
        try:
            ent = _walk(be, f"{pre}/entrada", 6)
            listo = any(o.key.endswith("/entrada/LISTO.json") for o in ent)
            step(f"leer {pre}/entrada", True, f"{len(ent)} objeto(s), {sum(max(o.size, 0) for o in ent)} bytes; "
                                              f"LISTO.json {'presente' if listo else 'ausente'}")
        except stg.StorageError as e:
            step(f"leer {pre}/entrada", False, str(e))
            worst = 2
        if a.sonda:
            if perms is not None and "escribir_estado" not in perms:
                step(f"sonda {pre}/estado", None, "omitida: la asignación no incluye escribir_estado")
                continue
            ts = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            key = f"{pre}/estado/probe-{ts}-{os.getpid()}.json"
            body = json.dumps({"probe": True, "at": now(), "host": socket.gethostname(),
                               "editor_version": EDITOR_VERSION}).encode()
            try:
                be.put_bytes_new(body, key, "application/json")
                back = be.read_bytes(key)
                ok = back == body
                step(f"sonda {key}", ok, "insertado y releído (sha256 coincide)" if ok else "releído distinto")
                worst = worst or (0 if ok else 2)
            except stg.StorageError as e:
                step(f"sonda {key}", False, str(e))
                worst = 2
    if not targets:
        worst = worst or 4
    return _check_end(a, rep, worst)


def _walk(be, prefix, depth):
    """Recursive listing (Supabase lists one level per call)."""
    if hasattr(be, "list_tree"):
        return be.list_tree(prefix, depth)
    return be.list(prefix)


def _jwt_sub(tok):
    from podcast_editor.supabase_backend import _jwt_claims
    return _jwt_claims(tok or "").get("sub", "?")


def _check_end(a, rep, code):
    rep["resultado"] = {0: "OK", 2: "FALLO", 4: "SIN EPISODIOS ASIGNADOS/VISIBLES"}.get(code, str(code))
    if a.json_out:
        write_json(Path(a.json_out), rep)
    print("RESULTADO:", rep["resultado"])
    return code


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Local podcast assembly editor")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="validate + render + verify")
    r.add_argument("manifest")
    r.add_argument("--work", default=str(Path(__file__).resolve().parent / "work"))
    r.add_argument("--dry-run", action="store_true")
    r.add_argument("--force", action="store_true", help="rerun a job already completed")
    r.add_argument("--no-cache", action="store_true", help="re-render all chunks")
    r.add_argument("--retries", type=int, default=2)
    r.add_argument("--keep-tmp", action="store_true", help="keep intermediate wav/mkv files")
    default_root = str(Path(__file__).resolve().parent / "bucket-local")
    pb = sub.add_parser("publish", help="insert outputs, verify, then write salida/COMPLETO.json last")
    pb.add_argument("manifest")
    pb.add_argument("--work", default=str(Path(__file__).resolve().parent / "work"))
    pb.add_argument("--backend", default="local", choices=["local", "supabase"])
    pb.add_argument("--root", default=default_root, help="local backend folder")
    pb.add_argument("--verificacion", default="completa", choices=["completa", "sidecar"],
                    help="completa = re-download and hash every object (default)")
    fe = sub.add_parser("fetch", help="wait for entrada/LISTO.json, download and verify every input")
    fe.add_argument("--episode", required=True)
    fe.add_argument("--version", required=True, type=int)
    fe.add_argument("--dest", required=True, help="local folder; montaje.json lands in <dest>/entrada/")
    fe.add_argument("--backend", default="local", choices=["local", "supabase"])
    fe.add_argument("--root", default=default_root)
    fe.add_argument("--esperar", type=float, default=0.0, help="seconds to wait for LISTO.json")
    fe.add_argument("--intervalo", type=float, default=30.0, help="poll interval while waiting")
    sg = sub.add_parser("firmar", help="signed URLs for published outputs (only after COMPLETO.json)")
    sg.add_argument("manifest")
    sg.add_argument("--backend", default="local", choices=["local", "supabase"])
    sg.add_argument("--root", default=default_root)
    sg.add_argument("--expira", type=int, default=3600)
    sg.add_argument("--objetos", nargs="+", default=["episodio.mp4", "episodio.mp3"])
    va = sub.add_parser("validate", help="validate montaje.json against docs/montaje.schema.json + editor rules")
    va.add_argument("manifest")
    va.add_argument("--archivos", action="store_true", help="also verify files, LISTO.json and media rules")
    va.add_argument("--json", action="store_true")
    ck = sub.add_parser("check-conexion", help="login + assignments + list entrada/ (+ optional estado probe)")
    ck.add_argument("--backend", default="supabase", choices=["local", "supabase"])
    ck.add_argument("--root", default=default_root)
    ck.add_argument("--episode")
    ck.add_argument("--version", type=int)
    ck.add_argument("--sonda", action="store_true", help="insert a tiny estado/probe-<ts>.json (insert-only)")
    ck.add_argument("--json-out", help="write the report to this file")
    a = ap.parse_args(argv)
    if a.cmd == "run":
        a.retries = max(0, min(a.retries, 5))
        return cmd_run(a)
    return {"publish": cmd_publish, "fetch": cmd_fetch, "firmar": cmd_sign, "validate": cmd_validate,
            "check-conexion": cmd_check}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
