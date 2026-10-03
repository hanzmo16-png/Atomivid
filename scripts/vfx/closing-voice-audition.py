"""Mix one converted phrase into unchanged picture. Word timing check is advisory to human listening."""
import json,pathlib,subprocess,sys,hashlib,zipfile,re
import numpy as np
from faster_whisper import WhisperModel
root=pathlib.Path(sys.argv[1]);c=json.loads((root/'config.json').read_text());receipt=json.loads((root/'conversion-receipt.json').read_text())
run=lambda args:subprocess.run(['ffmpeg','-v','error','-y',*args],check=True)
def duration(p):return float(json.loads(subprocess.check_output(['ffprobe','-v','error','-show_format','-of','json',str(p)]))['format']['duration'])
target=c['phraseEnd']-c['phraseStart'];actual=duration(root/'converted.mp3');rate=actual/target
if not .95<=rate<=1.05:raise ValueError('VFX_CONVERTED_TIMING_OUTSIDE_FIT_LIMIT')
run(['-i',str(root/'converted.mp3'),'-af',f'atempo={rate},apad=whole_dur={target},atrim=duration={target}','-ac','1','-ar','48000','-c:a','pcm_s16le',str(root/'converted-fit.wav')])
model=WhisperModel('base',device='cpu',compute_type='int8',cpu_threads=4)
segments,info=model.transcribe(str(root/'converted-fit.wav'),language='es',beam_size=5,word_timestamps=True,vad_filter=True)
converted=[dict(start=w.start,end=w.end,word=w.word,probability=w.probability) for s in segments for w in s.words]
original=c['originalPhraseWords']
norm=lambda w:re.sub(r'[^a-záéíóúüñ0-9]','',w.lower())
match=len(original)==len(converted) and all(norm(a['word'])==norm(b['word']) for a,b in zip(original,converted))
drifts=[abs(a['start']-c['phraseStart']-b['start']) for a,b in zip(original,converted)] if match else []
maxdrift=max(drifts,default=None);timingPass=match and maxdrift<=.15
# Match converted level to recorded phrase. Keep all other recorded words and pauses.
def pcm(path):return np.frombuffer(subprocess.check_output(['ffmpeg','-v','error','-i',str(path),'-ac','1','-ar','48000','-f','f32le','-']),np.float32)
source=pcm(root/'original.mp4');phrase=pcm(root/'converted-fit.wav');a=round(c['phraseStart']*48000);b=round(c['phraseEnd']*48000);base=source[a:b]
def rms(x):x=x[np.abs(x)>.01];return np.sqrt(np.mean(x*x)) if len(x) else .01
gain=float(np.clip(rms(base)/max(rms(phrase),.001),.25,4));phrase=np.clip(phrase*gain,-.95,.95)
if abs(len(phrase)-(b-a))>2400:raise ValueError('VFX_VOICE_PCM_LENGTH_CHANGED')
phrase=np.pad(phrase,(0,max(0,b-a-len(phrase))))[:b-a];fade=min(480,len(phrase)//4);phrase[:fade]*=np.linspace(0,1,fade);phrase[-fade:]*=np.linspace(1,0,fade);mixed=source.copy();mixed[a:b]=phrase
(root/'mixed.f32').write_bytes(mixed.astype(np.float32).tobytes());run(['-f','f32le','-ar','48000','-ac','1','-i',str(root/'mixed.f32'),'-af','volume=-6dB,highpass=f=75,alimiter=limit=0.89:level=disabled','-c:a','pcm_s16le',str(root/'mixed.wav')])
stage=(root/'stage.mp4').exists();offset=0
if stage:
 sr=json.loads((root/'stage-report.json').read_text());offset=sr['trim'][0];video=root/'stage.mp4';seconds=duration(video)
else:
 video=root/'visual.mp4';seconds=duration(root/'original.mp4')
 tone='zscale=tin=arib-std-b67:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,fps=30'
 run(['-i',str(root/'original.mp4'),'-vf',tone,'-an','-c:v','libx264','-crf','18','-preset','fast',str(video)])
final=root/'ATOMIVID-cierre-prueba-voz-Termopilas.mp4';run(['-i',str(video),'-ss',str(offset),'-i',str(root/'mixed.wav'),'-map','0:v:0','-map','1:a:0','-t',str(seconds),'-c:v','copy','-c:a','aac','-b:a','192k','-movflags','+faststart',str(final)])
run(['-i',str(root/'converted-fit.wav'),'-c:a','libmp3lame','-b:a','128k',str(root/'ATOMIVID-frase-voz-Termopilas.mp3')])
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
report=dict(voiceId=c['voiceId'],modelId=c['modelId'],phrase=[c['phraseStart'],c['phraseEnd']],originalWords=original,convertedWords=converted,wordMatch=match,maxWordStartDriftSeconds=maxdrift,timingCheckPassed=bool(timingPass),fitRate=rate,originalVoiceOutsidePhrase=True,visualFramesUnchanged=True,stageBackground=stage,backgroundKind='internal launch-stage graphic preview' if stage else 'original recording for voice audition',humanListeningRequired=True,humanLipSyncReviewRequired=True,reviewApproved=False,masterApproved=False,music=False,sha256=sha(final),receipt=receipt)
(root/'voice-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
with zipfile.ZipFile(root/'voice-review.zip','w',zipfile.ZIP_DEFLATED) as z:
 for p in [final,root/'ATOMIVID-frase-voz-Termopilas.mp3',root/'voice-report.json']:z.write(p,p.name)
