# Free local transcription (faster-whisper, CPU) of the finished Long Form, compared with the script narration:
# coverage = share of the script's words heard in order; the tail check proves the ending is not cut. Prints ratios only.
import json, os, re, sys, difflib, unicodedata
from faster_whisper import WhisperModel
evid, work = os.environ["EVID"], os.environ.get("RUNNER_TEMP", "/tmp")
def words(t):
    t = unicodedata.normalize("NFKD", t.lower()); t = "".join(c for c in t if not unicodedata.combining(c))
    return re.findall(r"[a-z0-9ñ]+", t)
model = WhisperModel("small", device="cpu", compute_type="int8")
segs, info = model.transcribe(os.path.join(work, "lf.wav"), language="es", word_timestamps=False, vad_filter=False)
segs = [{"start": round(s.start, 1), "end": round(s.end, 1), "text": s.text.strip()} for s in segs]
json.dump(segs, open(os.path.join(evid, "transcript.json"), "w"), ensure_ascii=False, indent=1)
script = words(open(os.path.join(evid, "narration.txt")).read()); heard = words(" ".join(s["text"] for s in segs))
sm = difflib.SequenceMatcher(None, script, heard, autojunk=False)
cov = sum(b.size for b in sm.get_matching_blocks()) / max(1, len(script))
tail = script[-25:]; tail_cov = sum(b.size for b in difflib.SequenceMatcher(None, tail, heard[-60:], autojunk=False).get_matching_blocks()) / max(1, len(tail))
first, last = (segs[0]["start"], segs[-1]["end"]) if segs else (None, None)
fails = 0
def ok(n, c, i=""):
    global fails
    print(f"{'PASS' if c else 'FAIL'} {n}{' — ' + i if i else ''}"); fails += 0 if c else 1
ok("narration complete: script words heard in order (≥ 85 %, whisper-small)", cov >= 0.85, f"{cov:.1%} of {len(script)} words")
ok("ending not cut: last 25 script words heard at the end (≥ 70 %)", tail_cov >= 0.7, f"{tail_cov:.0%}")
ok("speech spans the video (starts ≤ 8 s)", first is not None and first <= 8, f"speech {first}–{last} s")
json.dump({"coverage": cov, "tailCoverage": tail_cov, "speech": [first, last], "segments": len(segs)}, open(os.path.join(evid, "transcribe.json"), "w"))
print(f"RESULT lf-transcribe: {fails} FAIL"); sys.exit(1 if fails else 0)
