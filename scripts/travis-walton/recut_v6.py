"""Re-cut the v5 30-minute mix so every inserted block sits at a sentence boundary (works on a COPY; USD 0).

Why: build_30_inputs.py chose each insertion point as the nearest inter-word gap to the chapter end, without looking
at punctuation, so six blocks landed one word into a sentence ("…end of sentence. First | block | rest of that sentence…"). Because the
original PCM was copied in order, the stranded word and the words after the block are contiguous original audio.
Rotating the window [cut, resume) puts them back together: no word surgery, no new voice, same total length.

Each move in the edit list (private; it carries narration text and stays out of this public repository) gives, in
v5 seconds:
  kind "forward":  the stranded words are BEFORE the block. cut = the gap before them, block_start, block_end.
                   out = mix[:cut] + mix[block_start:block_end] + mix[cut:block_start] + mix[block_end:]
  kind "backward": the stranded words are AFTER the block. block_start, block_end, cut = the gap after them.
                   out = mix[:block_start] + mix[block_end:cut] + mix[block_start:block_end] + mix[cut:]
block_start/block_end must be the exact splice points (the build report's insertionSplices, shifted to v5 time);
the script refuses a value that is not on a 25 fps frame boundary, and never guesses.

Checks before anything is written: input hashes, decoded length, windows that do not overlap each other or any
avatar interval, cut points inside a real inter-word gap of the word timing file. After the edit: total length
unchanged, every sample outside the rotated windows (including all avatar intervals) bit-identical to the input,
and the re-timed words in non-decreasing order. Outputs: the edited WAV, the re-timed words, ±8 s listening clips
around every new seam and a JSON report (hashes, shifts per window for the visual timeline). It never uploads,
publishes or replaces anything.

Usage: python3 recut_v6.py --mix v5.mp3 --mix-sha256 <hex> --words words.json --words-sha256 <hex> \
         --edl edl.json --out DIR
"""
from __future__ import annotations
import argparse, hashlib, json, subprocess, sys, wave
from pathlib import Path
import numpy as np

SR = 48000
FPS = 25
FADE = int(0.005 * SR)  # 5 ms de-click at each new seam, inside the seam (length unchanged)
AVATARS = [(66.60, 87.00), (281.64, 304.04), (1418.48, 1442.56), (1775.72, 1800.00)]


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def decode(src: Path, dst: Path) -> np.ndarray:
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(src), "-ar", str(SR), "-ac", "2", "-c:a", "pcm_s16le", str(dst)], check=True)
    with wave.open(str(dst), "rb") as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).reshape(-1, 2).copy()


def write_wav(p: Path, a: np.ndarray) -> None:
    with wave.open(str(p), "wb") as w:
        w.setparams((2, 2, SR, 0, "NONE", "not compressed"))
        w.writeframes(a.astype(np.int16).tobytes())


def on_frame(t: float) -> bool:
    return abs(t * FPS - round(t * FPS)) < 1e-6


def in_gap(words: list[dict], t: float) -> bool:
    """t lies strictly between two consecutive words (never inside a word)."""
    return all(not (w["start"] < t < w["end"]) for w in words) and any(a["end"] <= t <= b["start"] for a, b in zip(words, words[1:]))


def plan(move: dict) -> tuple[int, int, list[tuple[int, int]]]:
    """Window [lo, hi) and, for re-timing, the pieces as (source_start, length) in output order."""
    s = lambda t: round(t * SR)
    if move["kind"] == "forward":
        cut, b0, b1 = s(move["cut"]), s(move["block_start"]), s(move["block_end"])
        assert cut < b0 < b1, move["id"]
        return cut, b1, [(b0, b1 - b0), (cut, b0 - cut)]
    if move["kind"] == "backward":
        b0, b1, cut = s(move["block_start"]), s(move["block_end"]), s(move["cut"])
        assert b0 < b1 < cut, move["id"]
        return b0, cut, [(b1, cut - b1), (b0, b1 - b0)]
    raise ValueError(f"{move['id']}: unknown kind")


def validate(moves: list[dict], words: list[dict], total_s: float) -> list[str]:
    errors, windows = [], []
    for m in moves:
        for k in ("block_start", "block_end"):
            if not on_frame(m[k]):
                errors.append(f"{m['id']}: {k}={m[k]} is not a 25 fps frame boundary (give the exact splice point)")
        if not in_gap(words, m["cut"]):
            errors.append(f"{m['id']}: cut={m['cut']} is not inside an inter-word gap")
        lo, hi, _ = plan(m)
        windows.append((lo / SR, hi / SR, m["id"]))
        for a, z in AVATARS:
            if lo / SR < z and a < hi / SR:
                errors.append(f"{m['id']}: window {lo / SR:.3f}–{hi / SR:.3f} overlaps avatar {a}–{z}")
        if hi / SR > total_s:
            errors.append(f"{m['id']}: window ends after the mix")
    windows.sort()
    for (a0, a1, ia), (b0, b1, ib) in zip(windows, windows[1:]):
        if b0 < a1:
            errors.append(f"windows {ia} and {ib} overlap")
    return errors


def apply(mix: np.ndarray, moves: list[dict]) -> tuple[np.ndarray, list[dict]]:
    """New joins, per kind (the other window edge becomes original audio that was contiguous in v4 again):
    forward:  window start (sentence end -> block start) and inner seam (block end -> stranded words);
    backward: inner seam (end of stranded words -> block start) and window end (block end -> following audio).
    De-click fades stay inside the window, so every sample outside it is untouched."""
    out = mix.copy()
    seams = []
    ramp_in = np.linspace(0.0, 1.0, FADE)[:, None]
    for m in moves:
        lo, hi, pieces = plan(m)
        rebuilt = np.concatenate([mix[a:a + n] for a, n in pieces])
        assert len(rebuilt) == hi - lo
        out[lo:hi] = rebuilt
        inner = lo + pieces[0][1]
        joins = [lo, inner] if m["kind"] == "forward" else [inner, hi]
        for p in joins:
            if p > lo:
                out[p - FADE:p] = (out[p - FADE:p] * ramp_in[::-1]).astype(np.int16)
            if p < hi:
                out[p:p + FADE] = (out[p:p + FADE] * ramp_in).astype(np.int16)
            seams.append({"id": m["id"], "sample": p})
    return out, seams


def retime(words: list[dict], moves: list[dict]) -> list[dict]:
    out = []
    for w in words:
        t0, t1 = w["start"], w["end"]
        shift = 0.0
        for m in moves:
            lo, hi, pieces = plan(m)
            s0 = round(t0 * SR)
            if lo <= s0 < hi:
                pos = lo
                for a, n in pieces:
                    if a <= s0 < a + n:
                        shift = (pos - a) / SR
                    pos += n
        out.append({**w, "start": round(t0 + shift, 6), "end": round(t1 + shift, 6)})
    out.sort(key=lambda w: w["start"])
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mix", type=Path, required=True)
    ap.add_argument("--mix-sha256", required=True)
    ap.add_argument("--words", type=Path, required=True)
    ap.add_argument("--words-sha256", required=True)
    ap.add_argument("--edl", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    for p, h in ((a.mix, a.mix_sha256), (a.words, a.words_sha256)):
        if sha256(p) != h:
            print(f"BLOQUEADO: {p.name} no coincide con el sha256 esperado; no se modificó nada")
            return 2
    a.out.mkdir(parents=True, exist_ok=True)
    words = json.loads(a.words.read_text())
    moves = json.loads(a.edl.read_text())["moves"]
    mix = decode(a.mix, a.out / "v5-decoded.wav")
    total = len(mix) / SR
    errors = validate(moves, words, total)
    if errors:
        print("BLOQUEADO:\n- " + "\n- ".join(errors))
        return 3
    out, seams = apply(mix, moves)
    assert len(out) == len(mix)
    untouched = np.ones(len(mix), dtype=bool)
    for m in moves:
        lo, hi, _ = plan(m)
        untouched[lo:hi] = False
    assert np.array_equal(out[untouched], mix[untouched]), "samples outside the windows changed"
    for z0, z1 in AVATARS:
        s0, s1 = round(z0 * SR), min(round(z1 * SR), len(mix))
        assert np.array_equal(out[s0:s1], mix[s0:s1]), f"avatar {z0}–{z1} changed"
    new_words = retime(words, moves)
    assert all(x["start"] <= y["start"] for x, y in zip(new_words, new_words[1:]))
    write_wav(a.out / "v6-recut.wav", out)
    (a.out / "v6-words.json").write_text(json.dumps(new_words, ensure_ascii=False, indent=2) + "\n")
    clips = []
    for sm in seams:
        c0, c1 = max(0, sm["sample"] - 8 * SR), min(len(out), sm["sample"] + 8 * SR)
        p = a.out / f"escucha-{sm['id']}-{sm['sample'] / SR:08.2f}.wav"
        write_wav(p, out[c0:c1])
        clips.append({"id": sm["id"], "seam_s": round(sm["sample"] / SR, 6), "file": p.name})
    report = {
        "input": {"mix_sha256": a.mix_sha256, "words_sha256": a.words_sha256, "seconds": total},
        "output": {"wav_sha256": sha256(a.out / "v6-recut.wav"), "words_sha256": sha256(a.out / "v6-words.json"), "seconds": len(out) / SR},
        "avatars_bit_identical": True, "outside_windows_bit_identical": True,
        "windows": [{"id": m["id"], "kind": m["kind"], "from_s": plan(m)[0] / SR, "to_s": plan(m)[1] / SR,
                     "shifts": [{"source_start_s": s / SR, "seconds": n / SR} for s, n in plan(m)[2]]} for m in moves],
        "listening_clips": clips,
        "not_checked": "Nobody has listened yet: seams, levels and pronunciation need a human review of the clips.",
    }
    (a.out / "informe.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: report[k] for k in ("output", "avatars_bit_identical", "outside_windows_bit_identical")}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
