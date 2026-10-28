# Free local alignment (faster-whisper, CPU): word timestamps of the paid master, mapped onto the SCRIPT's own words
# (exact text, with punctuation) by sequence matching; unmatched script words take interpolated times between their
# matched neighbours. Usage: python3 pod-align.py master.wav script.txt out.json  → [{"text","start","end"}...]
import json, re, sys, difflib, unicodedata, wave
import numpy as np
from faster_whisper import WhisperModel

def norm(t):
    t = unicodedata.normalize("NFKD", t.lower()); t = "".join(c for c in t if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9ñ]+", "", t)

wav, script_file, out = sys.argv[1:4]
w = wave.open(wav)
audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
segs, _ = WhisperModel("small", device="cpu", compute_type="int8").transcribe(audio, language="es", word_timestamps=True, vad_filter=False)
heard = [(norm(x.word), x.start, x.end) for s in segs for x in (s.words or []) if norm(x.word)]
# Script words: drop the «Name:» speaker prefix of each line, keep the text exactly as written.
tokens = []
for line in open(script_file, encoding="utf8").read().splitlines():
    line = re.sub(r"^[^:]{1,60}:\s*", "", line.strip())
    tokens += [t for t in line.split() if norm(t)]
a, b = [norm(t) for t in tokens], [h[0] for h in heard]
times = [None] * len(tokens)
for blk in difflib.SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks():
    for k in range(blk.size): times[blk.a + k] = (heard[blk.b + k][1], heard[blk.b + k][2])
matched = sum(t is not None for t in times)
# Interpolate the gaps between matched neighbours.
i = 0
while i < len(times):
    if times[i] is not None: i += 1; continue
    j = i
    while j < len(times) and times[j] is None: j += 1
    lo = times[i - 1][1] if i > 0 else 0.0
    hi = times[j][0] if j < len(times) else (heard[-1][2] if heard else lo + 0.4 * (j - i))
    step = max(0.05, (hi - lo) / (j - i + 1))
    for k in range(i, j): times[k] = (lo + step * (k - i + 1) - step * 0.5, lo + step * (k - i + 1))
    i = j
json.dump([{"text": t, "start": round(s, 3), "end": round(e, 3)} for t, (s, e) in zip(tokens, times)], open(out, "w"), ensure_ascii=False)
print(json.dumps({"scriptWords": len(tokens), "heardWords": len(heard), "matched": matched, "matchedPct": round(100 * matched / max(1, len(tokens)), 1)}))
