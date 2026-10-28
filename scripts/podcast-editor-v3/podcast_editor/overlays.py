"""Temporary on-screen labels (opt-in) and subtitle cue limits. Pure, stdlib only.

By default a segment's `label`/`credit` stays on screen for the whole segment (unchanged behaviour). With
`labels._modo = "temporal"` in montaje.json each label is shown briefly, with a fade, at the START of every group
of consecutive segments that carry the same label text:

  labels._duracion_s        normal labels (e.g. "Recreación de IA"), default 2.0 s
  labels._duracion_larga_s  chapter titles and attributions, default 3.0 s. A label is "long" when its segment has
                            a `credit`, or its text uses the " | " separator ("CAPÍTULO | rótulo",
                            "autor · año | fuente · licencia")
  labels._fade_in_ms / _fade_out_ms   default 300 / 400
  <segment>._label_offset   seconds after the group start at which the label appears (default 0)
  <segment>._label_duracion_s         explicit duration for that group (overrides the two above)

A window never extends past its group, so a label never leaks onto the next shot. Rendering is per segment
(chunk), so a window that spans several segments is split and the fade is applied only at the window's real
start and end. Media, audio and segment timing are never changed: only the ASS events.
"""
from __future__ import annotations

TEMPORAL = "temporal"
LONG_SEPARATOR = " | "
DEFAULTS = {"_duracion_s": 2.0, "_duracion_larga_s": 3.0, "_fade_in_ms": 300, "_fade_out_ms": 400}
_EPS = 1e-6


def label_text(seg: dict) -> str:
    return "\n".join(x for x in (seg.get("label"), seg.get("credit")) if x)


def is_temporal(labels_cfg: dict | None) -> bool:
    return (labels_cfg or {}).get("_modo") == TEMPORAL


def cfg_errors(labels_cfg: dict | None, segments: list[dict]) -> list[str]:
    """Editor-level checks for the private temporal keys (the schema only allows '_' keys, it does not type them)."""
    out: list[str] = []
    cfg = labels_cfg or {}
    modo = cfg.get("_modo")
    if modo not in (None, "fijo", TEMPORAL):
        out.append(f"labels._modo must be 'fijo' or '{TEMPORAL}', got {modo!r}")
    for k in DEFAULTS:
        if k in cfg and (not isinstance(cfg[k], (int, float)) or isinstance(cfg[k], bool) or cfg[k] < 0
                         or (k.startswith("_duracion") and cfg[k] == 0)):
            out.append(f"labels.{k} must be a positive number")
    for s in segments:
        for k in ("_label_offset", "_label_duracion_s"):
            if k in s:
                v = s[k]
                if not isinstance(v, (int, float)) or isinstance(v, bool) or v < 0 or (k == "_label_duracion_s" and v == 0):
                    out.append(f"segment {s.get('id')}: {k} must be a {'positive' if k == '_label_duracion_s' else 'non-negative'} number")
    return out


def label_windows(segments: list[dict], labels_cfg: dict | None) -> dict[str, tuple[float, float]]:
    """Absolute [start, end) on-screen window of each temporal label, keyed by the id of the group's first segment.
    Segments need 'id', 'start' and 'dur' (seconds, as resolved by the editor)."""
    if not is_temporal(labels_cfg):
        return {}
    cfg = {**DEFAULTS, **{k: v for k, v in (labels_cfg or {}).items() if k in DEFAULTS}}
    out: dict[str, tuple[float, float]] = {}
    i = 0
    while i < len(segments):
        text = label_text(segments[i])
        j = i + 1
        while j < len(segments) and text and label_text(segments[j]) == text:
            j += 1
        if text:
            first, last = segments[i], segments[j - 1]
            g0, g1 = float(first["start"]), float(last["start"]) + float(last["dur"])
            if "_label_duracion_s" in first:
                d = float(first["_label_duracion_s"])
            elif any(s.get("credit") for s in segments[i:j]) or LONG_SEPARATOR in text:
                d = float(cfg["_duracion_larga_s"])
            else:
                d = float(cfg["_duracion_s"])
            a = g0 + float(first.get("_label_offset", 0.0))
            z = min(a + d, g1)
            if z > a + _EPS:
                out[first["id"]] = (a, z)
        i = j
    return out


def group_window_for(segments: list[dict], windows: dict[str, tuple[float, float]], index: int) -> tuple[float, float] | None:
    """The window that may cover segments[index]: the one of the first segment of its same-label group."""
    text = label_text(segments[index])
    if not text:
        return None
    k = index
    while k > 0 and label_text(segments[k - 1]) == text:
        k -= 1
    return windows.get(segments[k]["id"])


def temporal_label_event(seg_start: float, seg_dur: float, window: tuple[float, float] | None, text: str, style: str,
                         fade_in_ms: int, fade_out_ms: int, ass_time, ass_escape) -> str | None:
    """ASS Dialogue for the part of `window` inside this segment (times relative to the segment), or None."""
    if not window or not text:
        return None
    seg_end = seg_start + seg_dur
    a, z = max(seg_start, window[0]), min(seg_end, window[1])
    if z <= a + _EPS:
        return None
    fi = int(fade_in_ms) if abs(a - window[0]) <= _EPS else 0
    fo = int(fade_out_ms) if abs(z - window[1]) <= _EPS else 0
    tag = f"{{\\fad({fi},{fo})}}" if fi or fo else ""
    return f"Dialogue: 1,{ass_time(a - seg_start)},{ass_time(z - seg_start)},{style},,0,0,0,,{tag}{ass_escape(text)}"


def clip_cues(cues: list[dict], total: float | None) -> list[dict]:
    """Subtitle cues never outlast the programme: ends are capped at `total`, cues starting at/after it dropped."""
    if total is None:
        return cues
    t = float(total)
    return [{**c, "end": min(float(c["end"]), t)} for c in cues if float(c["start"]) < t - _EPS]
