# Free local transcription (faster-whisper, CPU) of a finished Podcast studio episode, with word timestamps, for the
# voice audit: what was heard against what the script said per turn, and when. Writes transcript.json to $EVID.
import json, os, wave
import numpy as np
from faster_whisper import WhisperModel
evid, work = os.environ["EVID"], os.environ.get("RUNNER_TEMP", "/tmp")
w = wave.open(os.path.join(work, "pod.wav"))  # 16 kHz mono s16 (ffmpeg)
audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
model = WhisperModel("small", device="cpu", compute_type="int8")
segs, _ = model.transcribe(audio, language="es", word_timestamps=True, vad_filter=False)
out = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip(),
        "words": [[round(x.start, 2), round(x.end, 2), x.word, round(x.probability, 2)] for x in s.words]} for s in segs]
json.dump(out, open(os.path.join(evid, "transcript.json"), "w"), ensure_ascii=False, indent=0)
print("TRANSCRIPT", json.dumps({"segments": len(out), "words": sum(len(s["words"]) for s in out)}))
