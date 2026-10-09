from pathlib import Path
import subprocess,json,sys,concurrent.futures
ROOT=Path(sys.argv[1]).resolve();OUT=ROOT/'edit';OUT.mkdir(exist_ok=True)
tracks=['tension-1','tension-2','tension-1','reflective-1','cinematic-2','reflective-1']
manifest=json.loads((ROOT/'narration/edit-manifest.json').read_text())
def mix(pair):
 i,b=pair;voice=ROOT/'narration'/(b['id']+('-clean' if b['id']=='n06' else '')+'.mp3');music=ROOT/'production-assets'/f'music-elevenlabs-{tracks[i]}.mp3';dur=b['seconds'];out=OUT/f'mix-{i}.wav'
 graph=f'[0:a]aresample=48000,aformat=channel_layouts=stereo,loudnorm=I=-16:TP=-1.5:LRA=8,asplit=2[v][sc];[1:a]aresample=48000,aformat=channel_layouts=stereo,loudnorm=I=-30:TP=-5:LRA=7,afade=t=in:d=1.2,afade=t=out:st={dur-2.5}:d=2.5[m];[m][sc]sidechaincompress=threshold=0.045:ratio=3:attack=40:release=750:makeup=1[duck];[v][duck]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.84:level=0[out]'
 p=subprocess.run(['ffmpeg','-v','error','-y','-i',str(voice),'-stream_loop','-1','-i',str(music),'-filter_complex',graph,'-map','[out]','-t',str(dur),'-ar','48000','-c:a','pcm_s16le',str(out)],capture_output=True)
 if p.returncode:raise RuntimeError(p.stderr.decode()[-1500:])
 print('MIXED',b['id'],flush=True);return out
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:files=list(pool.map(mix,enumerate(manifest['blocks'])))
(OUT/'mix-concat.txt').write_text(''.join(f"file '{f}'\n" for f in files))
r=subprocess.run(['ffmpeg','-v','error','-y','-f','concat','-safe','0','-i',str(OUT/'mix-concat.txt'),'-c:a','libmp3lame','-b:a','192k','-id3v2_version','3','-metadata','title=Travis Walton: cinco días fuera del mundo','-metadata','artist=Hans Moreno','-metadata','album=Crónicas y Misterios del Universo',str(ROOT/'Travis-Walton-podcast-Hans.mp3')],capture_output=True)
if r.returncode:raise RuntimeError(r.stderr.decode()[-1500:])
print('PODCAST_MIX_READY',flush=True)
