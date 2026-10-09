"""Mix preserved narration and licensed music locally with explicit PCM lengths."""
from pathlib import Path
import subprocess,json,sys,wave
import numpy as np
ROOT=Path(sys.argv[1]).resolve();OUT=ROOT/'edit';OUT.mkdir(exist_ok=True)
SR=48000
manifest=json.loads((ROOT/'narration/edit-manifest.json').read_text())
tracks=['tension-1','tension-2','tension-1','reflective-1','cinematic-2','reflective-1']
def run(a):subprocess.run(['ffmpeg','-nostdin','-v','error','-y',*a],check=True)
def read(p):
 with wave.open(str(p),'rb') as w:
  assert w.getframerate()==SR and w.getnchannels()==2 and w.getsampwidth()==2
  return np.frombuffer(w.readframes(w.getnframes()),dtype='<i2').reshape(-1,2).astype(np.float32)/32768
voicefile=OUT/'voice-normalized.wav'
if not voicefile.exists():run(['-i',str(ROOT/'Travis-Walton-narracion-Hans.mp3'),'-af','loudnorm=I=-16:TP=-1.5:LRA=8','-ar',str(SR),'-ac','2','-c:a','pcm_s16le',str(voicefile)])
voice=read(voicefile)
total=round(sum(b['seconds'] for b in manifest['blocks'])*25)/25
assert abs(len(voice)/SR-total)<.5
music={}
for name in set(tracks):
 p=OUT/f'music-normalized-{name}.wav'
 run(['-i',str(ROOT/'production-assets'/f'music-elevenlabs-{name}.mp3'),'-af','loudnorm=I=-27:TP=-4:LRA=7','-ar',str(SR),'-ac','2','-c:a','pcm_s16le',str(p)])
 music[name]=read(p)
N=round(total*SR);bed=np.zeros((N,2),np.float32);pos=0
for b,name in zip(manifest['blocks'],tracks):
 n=min(N-pos,round(b['seconds']*SR));src=music[name];segment=np.zeros((n,2),np.float32)
 fade=round(1.5*SR);stride=len(src)-fade
 for offset in range(0,n,stride):
  take=min(len(src),n-offset);part=src[:take].copy()
  if offset:part[:min(fade,take)]*=np.linspace(0,1,min(fade,take),dtype=np.float32)[:,None]
  if offset+len(src)<n:part[-fade:]*=np.linspace(1,0,fade,dtype=np.float32)[:,None]
  segment[offset:offset+take]+=part
 f=min(2*SR,n//2);segment[:f]*=np.linspace(0,1,f,dtype=np.float32)[:,None];segment[-f:]*=np.linspace(1,0,f,dtype=np.float32)[:,None]
 bed[pos:pos+n]=segment;pos+=n
# Gentle ducking preserves music through pauses. Work in 20 ms windows.
step=960;gain=1.
for p in range(0,N,step):
 v=voice[p:min(p+step,len(voice))];rms=float(np.sqrt(np.mean(v*v))) if len(v) else 0
 target=.58 if rms>.025 else 1.
 gain+=(target-gain)*(.33 if target<gain else .025)
 bed[p:p+step]*=gain
bed[:len(voice)]+=voice
peak=float(np.max(np.abs(bed)))
if peak>.89:bed*=.89/peak
with wave.open(str(OUT/'podcast-mix.wav'),'wb') as w:
 w.setnchannels(2);w.setsampwidth(2);w.setframerate(SR)
 for p in range(0,N,SR*10):w.writeframes((bed[p:p+SR*10]*32767).astype('<i2').tobytes())
run(['-i',str(OUT/'podcast-mix.wav'),'-c:a','libmp3lame','-b:a','192k','-id3v2_version','3','-metadata','title=Travis Walton: cinco días fuera del mundo','-metadata','artist=Hans Moreno','-metadata','album=Crónicas y Misterios del Universo',str(ROOT/'Travis-Walton-podcast-Hans.mp3')])
print('PODCAST_MIX_READY',total,'voice',len(voice)/SR,'peak',peak,flush=True)
