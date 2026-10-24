"""Synthetic test for recut_v6.py (no episode media, no narration text): python3 scripts/travis-walton/recut_v6_test.py"""
import hashlib, json, sys, tempfile, unittest, wave
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import recut_v6 as R  # noqa: E402

SR = R.SR


def write(p, a):
    with wave.open(str(p), "wb") as w:
        w.setparams((2, 2, SR, 0, "NONE", "not compressed"))
        w.writeframes(a.astype(np.int16).tobytes())


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


class Recut(unittest.TestCase):
    def setUp(self):
        self.d = Path(tempfile.mkdtemp())
        # "v4": a strictly increasing ramp (mod 30000), so contiguity can be checked sample by sample.
        orig = (np.arange(int(40 * SR)) % 30000).astype(np.int16)
        self.orig = np.stack([orig, orig], axis=1)
        # Two blocks inserted ONE WORD into a sentence (the v5 bug), at frame-aligned points.
        # forward: stranded word 10.00–10.20 before block A (inserted at 10.40, 3.00 s long)
        # backward: block B inserted at 25.00 (2.00 s long) between "la" and "otra."; stranded word 25.00–25.30
        blockA = np.full((int(3 * SR), 2), -1000, np.int16)
        blockB = np.full((int(2 * SR), 2), -2000, np.int16)
        a_at, b_at = int(10.40 * SR), int(25.00 * SR)
        self.v5 = np.concatenate([self.orig[:a_at], blockA, self.orig[a_at:b_at], blockB, self.orig[b_at:]])
        write(self.d / "v5.wav", self.v5)
        sh = lambda t: t if t < 10.40 else t + 3.0 if t < 25.00 else t + 5.0
        words = []
        for t0, t1 in [(9.30, 9.95), (10.00, 10.20), (10.45, 10.90), (24.40, 24.95), (25.00, 25.30), (25.40, 26.00)]:
            words.append({"text": "w", "start": round(sh(t0), 6), "end": round(sh(t1), 6)})
        # block words
        words += [{"text": "a", "start": 10.60, "end": 13.20}, {"text": "b", "start": 28.10, "end": 29.90}]
        words.sort(key=lambda w: w["start"])
        (self.d / "words.json").write_text(json.dumps(words))
        self.edl = {"moves": [
            {"id": "F", "kind": "forward", "cut": 9.975, "block_start": 10.40, "block_end": 13.40},
            {"id": "B", "kind": "backward", "block_start": 28.00, "block_end": 30.00, "cut": 30.35},
        ]}
        (self.d / "edl.json").write_text(json.dumps(self.edl))

    def run_main(self, edl=None):
        if edl is not None:
            (self.d / "edl.json").write_text(json.dumps(edl))
        return R.main(["--mix", str(self.d / "v5.wav"), "--mix-sha256", sha(self.d / "v5.wav"), "--words", str(self.d / "words.json"),
                       "--words-sha256", sha(self.d / "words.json"), "--edl", str(self.d / "edl.json"), "--out", str(self.d / "out")])

    def test_rotation_restores_contiguous_original_and_keeps_length(self):
        self.assertEqual(self.run_main(), 0)
        with wave.open(str(self.d / "out" / "v6-recut.wav")) as w:
            out = np.frombuffer(w.readframes(w.getnframes()), np.int16).reshape(-1, 2)
        self.assertEqual(len(out), len(self.v5))
        # Forward: block A now starts at the sentence gap (9.975) and the stranded word follows it, contiguous
        # with the original audio that resumes after the block.
        a0 = round(9.975 * SR)
        self.assertTrue((out[a0 + R.FADE:a0 + int(3 * SR) - R.FADE, 0] == -1000).all())
        rest = out[a0 + int(3 * SR) + R.FADE:round(28.00 * SR), 0].astype(int)
        self.assertTrue((np.diff(rest) % 30000 == 1).all(), "original audio is contiguous again after block A")
        # Backward: the stranded word sits right after the original sentence start, contiguous; block B after it.
        b0 = round(28.00 * SR)
        seg = out[b0 - 2 * SR:b0 + round(0.35 * SR) - R.FADE, 0].astype(int)
        self.assertTrue((np.diff(seg) % 30000 == 1).all(), "«la otra.» contiguous again")
        self.assertTrue((out[b0 + round(0.35 * SR) + R.FADE:b0 + round(0.35 * SR) + int(2 * SR) - R.FADE, 0] == -2000).all())
        rep = json.loads((self.d / "out" / "informe.json").read_text())
        self.assertTrue(rep["avatars_bit_identical"] and rep["outside_windows_bit_identical"])
        self.assertEqual(len(rep["listening_clips"]), 4)
        nw = json.loads((self.d / "out" / "v6-words.json").read_text())
        stranded = [w for w in nw if w["text"] == "w" and abs((w["end"] - w["start"]) - 0.20) < 1e-6][0]
        self.assertAlmostEqual(stranded["start"], 13.00, places=3)  # 10.00 + block A (3.0 s), now after the block

    def test_refuses_bad_inputs_without_writing(self):
        bad = json.loads(json.dumps(self.edl)); bad["moves"][0]["block_start"] = 10.41
        self.assertEqual(self.run_main(bad), 3, "a splice point off the 25 fps grid is refused")
        bad = json.loads(json.dumps(self.edl)); bad["moves"][0]["cut"] = 10.10
        self.assertEqual(self.run_main(bad), 3, "a cut inside a word is refused")
        bad = json.loads(json.dumps(self.edl)); bad["moves"][1] = {"id": "X", "kind": "forward", "cut": 1.0, "block_start": 1.04, "block_end": 70.0}
        self.assertEqual(self.run_main(bad), 3, "windows overlapping each other or an avatar are refused")
        self.assertFalse((self.d / "out" / "v6-recut.wav").exists())
        self.assertEqual(R.main(["--mix", str(self.d / "v5.wav"), "--mix-sha256", "0" * 64, "--words", str(self.d / "words.json"),
                                 "--words-sha256", sha(self.d / "words.json"), "--edl", str(self.d / "edl.json"), "--out", str(self.d / "o2")]), 2)


if __name__ == "__main__":
    unittest.main()
