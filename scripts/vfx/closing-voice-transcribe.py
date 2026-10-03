"""Local Spanish transcription with word timestamps. No paid transcription provider."""
import json,pathlib,sys
from faster_whisper import WhisperModel
root=pathlib.Path(sys.argv[1])
model=WhisperModel('base',device='cpu',compute_type='int8',cpu_threads=4)
segments,info=model.transcribe(str(root/'original.mp4'),language='es',beam_size=5,word_timestamps=True,vad_filter=True)
data=[dict(start=s.start,end=s.end,text=s.text,words=[dict(start=w.start,end=w.end,word=w.word,probability=w.probability) for w in s.words]) for s in segments]
(root/'transcript.json').write_text(json.dumps(data,ensure_ascii=False))
if not data:raise ValueError('VFX_NO_SPEECH_DETECTED')
