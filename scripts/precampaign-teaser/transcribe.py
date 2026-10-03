"""Local, free transcription (faster-whisper on CPU) with word timestamps.
Usage: python3 transcribe.py <audio.wav> <out.json> [model]
No external API: the model runs on the CI runner. Output: {"text", "words": [{"text","start","end","probability"}]}.
"""
import json
import sys
import wave

import numpy as np
from faster_whisper import WhisperModel

audio, out = sys.argv[1], sys.argv[2]
model_name = sys.argv[3] if len(sys.argv) > 3 else "small"
model = WhisperModel(model_name, device="cpu", compute_type="int8")
# Decode the 16 kHz mono PCM WAV ourselves (no PyAV dependency).
with wave.open(audio, "rb") as w:
    assert w.getframerate() == 16000 and w.getnchannels() == 1, "expects 16 kHz mono WAV"
    samples = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
segments, info = model.transcribe(samples, language="es", word_timestamps=True, vad_filter=False, beam_size=5, condition_on_previous_text=False)
words, texts = [], []
for seg in segments:
    texts.append(seg.text.strip())
    for w in seg.words or []:
        words.append({"text": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3), "probability": round(w.probability, 3)})
with open(out, "w", encoding="utf-8") as f:
    json.dump({"text": " ".join(texts).strip(), "language": info.language, "words": words}, f, ensure_ascii=False, indent=1)
print(json.dumps({"file": audio, "text": " ".join(texts).strip()}, ensure_ascii=False))
