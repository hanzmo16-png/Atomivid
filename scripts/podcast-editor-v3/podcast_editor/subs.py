"""Subtitle parsing + per-chunk ASS generation.

Ported from Atomivid scripts/travis-walton/edit.py (ass_time, HEADER styles
Caption/Source/Title, 7-word / sentence-end grouping, per-word highlight),
but everything that was hardcoded is now taken from the manifest.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

# Defaults = the styles edit.py used (kept so the TW look can be reproduced).
DEFAULT_STYLES = {
    "Caption": dict(Fontname="DejaVu Sans", Fontsize=45, PrimaryColour="&H00FFFFFF", SecondaryColour="&H00FFFFFF",
                    OutlineColour="&H00202020", BackColour="&H70000000", Bold=-1, Italic=0, Underline=0, StrikeOut=0,
                    ScaleX=100, ScaleY=100, Spacing=0, Angle=0, BorderStyle=1, Outline=2.4, Shadow=1, Alignment=2,
                    MarginL=160, MarginR=160, MarginV=86, Encoding=1),
    "Source": dict(Fontname="DejaVu Sans", Fontsize=22, PrimaryColour="&H00E1E1E1", SecondaryColour="&H00E1E1E1",
                   OutlineColour="&H00202020", BackColour="&H70000000", Bold=0, Italic=0, Underline=0, StrikeOut=0,
                   ScaleX=100, ScaleY=100, Spacing=1, Angle=0, BorderStyle=1, Outline=1, Shadow=0, Alignment=7,
                   MarginL=64, MarginR=64, MarginV=46, Encoding=1),
    "Title": dict(Fontname="DejaVu Sans", Fontsize=72, PrimaryColour="&H00FFFFFF", SecondaryColour="&H00FFFFFF",
                  OutlineColour="&H00202020", BackColour="&H70000000", Bold=-1, Italic=0, Underline=0, StrikeOut=0,
                  ScaleX=100, ScaleY=100, Spacing=1, Angle=0, BorderStyle=1, Outline=2, Shadow=0, Alignment=5,
                  MarginL=100, MarginR=100, MarginV=0, Encoding=1),
}
STYLE_FIELDS = list(DEFAULT_STYLES["Caption"].keys())


def ass_time(s: float) -> str:
    c = max(0, round(s * 100))
    return f"{c // 360000}:{c // 6000 % 60:02}:{c // 100 % 60:02}.{c % 100:02}"


def ass_escape(t: str) -> str:
    return t.replace("\\", "/").replace("{", "(").replace("}", ")").replace("\r", "").replace("\n", "\\N")


def header(w: int, h: int, overrides: dict | None) -> str:
    styles = {k: dict(v) for k, v in DEFAULT_STYLES.items()}
    for name, ov in (overrides or {}).items():
        styles.setdefault(name, dict(DEFAULT_STYLES["Caption"])).update(ov)
    lines = ["[Script Info]", "ScriptType: v4.00+", f"PlayResX: {w}", f"PlayResY: {h}",
             "ScaledBorderAndShadow: yes", "WrapStyle: 0", "", "[V4+ Styles]",
             "Format: Name," + ",".join(STYLE_FIELDS)]
    for name, st in styles.items():
        lines.append(f"Style: {name}," + ",".join(str(st[f]) for f in STYLE_FIELDS))
    lines += ["", "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text", ""]
    return "\n".join(lines)


_TS = re.compile(r"(\d+):(\d{2}):(\d{2})[,.](\d{1,3})")


def _ts(s: str) -> float:
    m = _TS.search(s)
    if not m:
        raise ValueError(f"bad SRT timestamp {s!r}")
    h, mi, se, ms = m.groups()
    return int(h) * 3600 + int(mi) * 60 + int(se) + int(ms.ljust(3, "0")) / 1000


def parse_srt(path: Path) -> list[dict]:
    txt = path.read_text(encoding="utf-8-sig").replace("\r\n", "\n")
    cues = []
    for block in re.split(r"\n\s*\n", txt.strip()):
        lines = [l for l in block.split("\n") if l.strip() != ""]
        if not lines:
            continue
        i = 1 if "-->" not in lines[0] else 0
        if i >= len(lines) or "-->" not in lines[i]:
            raise ValueError(f"bad SRT block: {block[:80]!r}")
        a, b = lines[i].split("-->")
        cues.append({"start": _ts(a), "end": _ts(b), "text": "\n".join(lines[i + 1:])})
    return cues


def load_words(path: Path) -> list[dict]:
    """words JSON: [{"text","start","end"}] absolute seconds (edit.py derived these
    from narration/edit-manifest.json blocks; here they are delivered explicitly)."""
    data = json.loads(path.read_text(encoding="utf-8"))
    words = data["words"] if isinstance(data, dict) else data
    return [{"text": str(w["text"]), "start": float(w["start"]), "end": float(w["end"])} for w in words]


def group_words(words: list[dict], max_words: int = 7) -> list[list[dict]]:
    groups, g = [], []
    for w in words:
        g.append(w)
        if len(g) >= max_words or w["text"].endswith((".", "?", "!")):
            groups.append(g)
            g = []
    if g:
        groups.append(g)
    return groups


class SubtitleTrack:
    """Unified view: cues (for SRT export + verification) and ASS events for a window."""

    def __init__(self, cfg: dict, path: Path):
        self.cfg = cfg
        self.fmt = cfg.get("format", "srt")
        self.highlight = cfg.get("highlight_colour", "&H8FE9E4&")
        if self.fmt == "srt":
            self.cues = parse_srt(path)
            self.groups = None
        elif self.fmt == "words_json":
            self.groups = group_words(load_words(path), int(cfg.get("group_max_words", 7)))
            self.cues = [{"start": g[0]["start"], "end": g[-1]["end"] + 0.1,
                          "text": " ".join(w["text"] for w in g)} for g in self.groups]
            # trim each group end to the next group start (avoid overlap from the +0.1 tail)
            for a, b in zip(self.cues, self.cues[1:]):
                a["end"] = min(a["end"], b["start"])
        else:
            raise ValueError(f"unknown subtitles.format {self.fmt}")

    def trim_to(self, end: float) -> None:
        """A caption tail must never outlive the delivered timeline/audio."""
        self.cues = [dict(c, end=min(c["end"], end)) for c in self.cues
                     if 0 <= c["start"] < min(c["end"], end)]

    def events(self, start: float, end: float) -> list[str]:
        out = []
        if self.groups is None:
            for c in self.cues:
                if c["end"] <= start or c["start"] >= end:
                    continue
                a, z = max(start, c["start"]), min(end, c["end"])
                if z > a:
                    out.append(f"Dialogue: 0,{ass_time(a - start)},{ass_time(z - start)},Caption,,0,0,0,,{ass_escape(c['text'])}")
            return out
        # karaoke-style word highlight (edit.py logic)
        for g in self.groups:
            if g[-1]["end"] < start or g[0]["start"] >= end:
                continue
            for i, w in enumerate(g):
                a = max(start, g[0]["start"] if i == 0 else w["start"])
                z = min(end, g[i + 1]["start"] if i + 1 < len(g) else g[-1]["end"] + 0.1)
                if z <= a:
                    continue
                text = " ".join((r"{\c" + self.highlight + "}" + ass_escape(x["text"]) + r"{\c&HFFFFFF&}") if j == i
                                else ass_escape(x["text"]) for j, x in enumerate(g))
                out.append(f"Dialogue: 0,{ass_time(a - start)},{ass_time(z - start)},Caption,,0,0,0,,{text}")
        return out

    def to_srt(self) -> str:
        def t(s):
            ms = max(0, round(s * 1000))
            return f"{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}"
        return "\n".join(f"{i}\n{t(c['start'])} --> {t(c['end'])}\n{c['text']}\n"
                         for i, c in enumerate(self.cues, 1))
