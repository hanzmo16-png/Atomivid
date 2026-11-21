"""Temporary labels (labels._modo = temporal) and subtitle cue limits. Synthetic data only: no media render, no
network, no project assets. Run: python3 -m unittest discover -s scripts/podcast-editor-v3/tests -p 'test_*.py'"""
from __future__ import annotations

import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from podcast_editor import overlays  # noqa: E402
from podcast_editor.subs import ass_escape, ass_time  # noqa: E402
from fixtures import base_manifest, meta, write_manifest  # noqa: E402

CFG = {"style": "Source", "_modo": "temporal", "_duracion_s": 2.0, "_duracion_larga_s": 3.0, "_fade_in_ms": 300, "_fade_out_ms": 400}
AI = "Recreación de IA"
ILL = "Imagen ilustrativa · no es archivo del caso"
CHAPTER = "CÓMO INVESTIGARÍAMOS HOY | " + ILL
ATTR = "Autor · 2019 | Fuente · CC BY-SA 4.0"


def segs(spec):
    """[(id, dur, label, extra)] -> resolved segments with absolute start/dur, like Plan.segments."""
    out, t = [], 0.0
    for sid, dur, label, extra in spec:
        s = {"id": sid, "start": t, "dur": dur, **({"label": label} if label else {}), **(extra or {})}
        out.append(s)
        t += dur
    return out


def event(segments, windows, i, cfg=CFG):
    s = segments[i]
    return overlays.temporal_label_event(s["start"], s["dur"], overlays.group_window_for(segments, windows, i),
                                         overlays.label_text(s), cfg["style"], cfg["_fade_in_ms"], cfg["_fade_out_ms"],
                                         ass_time, ass_escape)


def t_of(ev):
    a, z = re.match(r"Dialogue: 1,([^,]+),([^,]+),", ev).groups()
    sec = lambda x: (lambda h, m, s: int(h) * 3600 + int(m) * 60 + float(s))(*x.split(":"))  # noqa: E731
    return sec(a), sec(z)


class TemporalLabels(unittest.TestCase):
    def test_durations_ai_2s_chapter_and_attribution_3s(self):
        s = segs([("a", 6, AI, None), ("b", 6, CHAPTER, None), ("c", 6, ATTR, None), ("d", 6, "Hans · Avatar de IA", None),
                  ("e", 6, None, {"credit": "Foto: X"})])
        w = overlays.label_windows(s, CFG)
        self.assertEqual({k: round(z - a, 6) for k, (a, z) in w.items()}, {"a": 2.0, "b": 3.0, "c": 3.0, "d": 2.0, "e": 3.0})

    def test_fade_300_400_inside_one_segment(self):
        s = segs([("a", 6, AI, None)])
        ev = event(s, overlays.label_windows(s, CFG), 0)
        self.assertIn(r"{\fad(300,400)}", ev)
        self.assertEqual(t_of(ev), (0.0, 2.0))

    def test_one_label_per_same_label_group_and_split_fades_across_segments(self):
        # Group of 3 shots with the same label; the first one is shorter than the label.
        s = segs([("a", 1.2, AI, None), ("b", 4, AI, None), ("c", 4, AI, None), ("d", 4, ILL, None)])
        w = overlays.label_windows(s, CFG)
        self.assertEqual(set(w), {"a", "d"})
        e0, e1, e2 = (event(s, w, i) for i in range(3))
        self.assertIn(r"{\fad(300,0)}", e0)  # fade-in only where the window starts
        self.assertEqual(t_of(e0), (0.0, 1.2))
        self.assertIn(r"{\fad(0,400)}", e1)  # fade-out only where it really ends
        self.assertEqual(t_of(e1), (0.0, 0.8))
        self.assertIsNone(e2)  # later shots of the group: no label
        self.assertEqual(t_of(event(s, w, 3)), (0.0, 2.0))

    def test_label_never_leaks_into_the_next_group(self):
        s = segs([("a", 1.0, CHAPTER, None), ("b", 5, AI, None)])
        w = overlays.label_windows(s, CFG)
        self.assertEqual(w["a"], (0.0, 1.0))  # truncated at the group end, not 3 s
        self.assertEqual(t_of(event(s, w, 1)), (0.0, 2.0))

    def test_x08_offset_places_the_chapter_title_at_25m46s(self):
        # A synthetic timeline shaped like the closing manifest: the chapter shot starts 0.6198 s before the voice.
        before = 1546.06 - 0.6198
        s = segs([("pre", before, AI, None), ("x08_shot_000", 10.6198, CHAPTER, {"_label_offset": 0.6198}),
                  ("x08_shot_001", 1800 - before - 10.6198, ILL, None)])
        w = overlays.label_windows(s, CFG)
        a, z = w["x08_shot_000"]
        self.assertAlmostEqual(a, 1546.06, places=6)
        self.assertEqual(f"{int(a // 60)}:{int(a % 60):02d}", "25:46")
        self.assertAlmostEqual(z - a, 3.0, places=6)
        ev = event(s, w, 1)
        self.assertAlmostEqual(t_of(ev)[0], 0.62, places=2)  # relative to the shot (centisecond ASS precision)
        self.assertIn(r"\fad(300,400)", ev)

    def test_no_two_label_windows_overlap(self):
        s = segs([(f"s{i}", 1.5 + (i % 3), [AI, AI, ILL, CHAPTER, ATTR][i % 5], {"_label_offset": 0.3} if i % 4 == 0 else None)
                  for i in range(40)])
        spans = sorted(overlays.label_windows(s, CFG).values())
        for (a0, z0), (a1, z1) in zip(spans, spans[1:]):
            self.assertLessEqual(z0, a1 + 1e-9)

    def test_explicit_duration_and_fixed_mode_unchanged(self):
        s = segs([("a", 6, AI, {"_label_duracion_s": 4.5})])
        self.assertEqual(overlays.label_windows(s, CFG)["a"], (0.0, 4.5))
        for cfg in (None, {}, {"style": "Source"}, {"_modo": "fijo"}):
            self.assertEqual(overlays.label_windows(s, cfg), {})

    def test_config_errors(self):
        self.assertEqual(overlays.cfg_errors(CFG, segs([("a", 1, AI, {"_label_offset": 0.5})])), [])
        errs = overlays.cfg_errors({"_modo": "flash", "_duracion_s": 0, "_fade_in_ms": -1},
                                   segs([("a", 1, AI, {"_label_offset": -1, "_label_duracion_s": "2"})]))
        self.assertEqual(len(errs), 5, errs)

    def test_srt_cues_capped_at_programme_length(self):
        cues = [{"start": 1795.0, "end": 1799.9, "text": "a"}, {"start": 1799.9, "end": 1800.04, "text": "b"},
                {"start": 1800.0, "end": 1800.5, "text": "c"}]
        out = overlays.clip_cues(cues, 1800)
        self.assertEqual([c["text"] for c in out], ["a", "b"])
        self.assertLessEqual(max(c["end"] for c in out), 1800.0)
        self.assertEqual(overlays.clip_cues(cues, None), cues)


class EditorIntegration(unittest.TestCase):
    """The real editor (Plan + Editor.chunk_spec) on a synthetic manifest of card segments: no media, no render."""

    def build(self, d: Path, labels):
        (d / "subs").mkdir(exist_ok=True)
        words = [{"text": "uno", "start": 0.2, "end": 0.6}, {"text": "dos", "start": 0.7, "end": 1.1},
                 {"text": "fin", "start": 11.5, "end": 11.98}]
        (d / "subs" / "w.json").write_text(json.dumps(words), encoding="utf-8")
        timeline = [{"id": "a", "type": "card", "duration": 1.2, "lines": ["A"], "label": AI},
                    {"id": "b", "type": "card", "duration": 4.8, "lines": ["B"], "label": AI},
                    {"id": "c", "type": "card", "duration": 6.0, "lines": ["C"], "label": CHAPTER, "_label_offset": 0.62}]
        extra = {"expected_total_seconds": 12, "subtitles": {"source": "subs", "format": "words_json", "mode": "burn"}}
        if labels is not None:
            extra["labels"] = labels
        m = base_manifest(d, [meta(d, "subs", "subs/w.json", "subtitulos")], timeline, **extra)
        mp = write_manifest(d, m)
        import editor  # noqa: E402
        plan = editor.Plan(mp)
        self.assertEqual(plan.errors, [])
        return editor.Editor(plan, d / "work")

    def test_temporal_changes_only_the_label_events_never_audio_or_shots(self):
        with tempfile.TemporaryDirectory() as t1, tempfile.TemporaryDirectory() as t2:
            fixed, temporal = self.build(Path(t1), {"style": "Source"}), self.build(Path(t2), CFG)
            for sf, st in zip(fixed.p.segments, temporal.p.segments):
                a, b = fixed.chunk_spec(sf), temporal.chunk_spec(st)
                strip = lambda spec: {k: v for k, v in spec.items() if k not in ("ass", "labels")}  # noqa: E731
                self.assertEqual(strip(a), strip(b), sf["id"])
                self.assertEqual(sf["frames"], st["frames"])
            ass = {s["id"]: temporal.chunk_ass(s) for s in temporal.p.segments}
            self.assertIn(r"{\fad(300,0)}Recreación de IA", ass["a"])
            self.assertIn(r"{\fad(0,400)}Recreación de IA", ass["b"])
            self.assertIn(r"Dialogue: 1,0:00:00.62,0:00:03.62,Source,,0,0,0,,{\fad(300,400)}CÓMO", ass["c"])
            fixed_ass = fixed.chunk_ass(fixed.p.segments[1])
            self.assertIn("Dialogue: 1,0:00:00.00,0:00:04.80,Source,,0,0,0,,Recreación de IA", fixed_ass)

    def test_srt_never_ends_after_expected_total(self):
        with tempfile.TemporaryDirectory() as t:
            ed = self.build(Path(t), None)
            self.assertLessEqual(max(c["end"] for c in ed.subs.cues), 12.0)

    def test_invalid_private_keys_are_reported_by_validation(self):
        with tempfile.TemporaryDirectory() as t:
            d = Path(t)
            m = base_manifest(d, [], [{"id": "a", "type": "card", "duration": 2, "lines": ["A"], "label": AI, "_label_offset": -1}],
                              labels={"_modo": "flash"})
            import editor  # noqa: E402
            plan = editor.Plan(write_manifest(d, m))
            self.assertTrue(any("_modo" in e for e in plan.errors), plan.errors)
            self.assertTrue(any("_label_offset" in e for e in plan.errors), plan.errors)


if __name__ == "__main__":
    unittest.main()
