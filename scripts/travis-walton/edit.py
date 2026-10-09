"""Local edit of paid/preserved episode media. Does not generate or submit provider calls."""
from pathlib import Path
import json, subprocess, concurrent.futures, math, re, sys
ROOT=Path(sys.argv[1]).resolve(); OUT=ROOT/'edit'; OUT.mkdir(exist_ok=True)
FPS=25; W=1920; H=1080
def run(args):
 r=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 if r.returncode:raise RuntimeError(r.stderr.decode(errors='replace')[-1800:])
 return r.stdout
def duration(p):return float(run(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',str(p)]))
manifest=json.loads((ROOT/'narration/edit-manifest.json').read_text())
words=[]; chapters=[]; t=0
for b in manifest['blocks']:
 n=len(b['chapters'][0]['text'].split()); split=b['words'][n]['startSeconds']
 chapters.extend([{'id':b['chapters'][0]['id'],'title':b['chapters'][0]['title'],'start':t,'end':t+split},{'id':b['chapters'][1]['id'],'title':b['chapters'][1]['title'],'start':t+split,'end':t+b['seconds']}])
 for w in b['words']:words.append({'text':w['text'],'start':t+w['startSeconds'],'end':t+w['endSeconds']})
 t+=b['seconds']
TOTAL=round(t*FPS)/FPS
(OUT/'chapters.json').write_text(json.dumps(chapters,ensure_ascii=False,indent=2))
def ass_time(s):
 c=max(0,round(s*100));return f'{c//360000}:{c//6000%60:02}:{c//100%60:02}.{c%100:02}'
HEADER='''[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
ScaledBorderAndShadow: yes
WrapStyle: 0
[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Caption,DejaVu Sans,45,&H00FFFFFF,&H00FFFFFF,&H00202020,&H70000000,-1,0,0,0,100,100,0,0,1,2.4,1,2,160,160,86,1
Style: Source,DejaVu Sans,22,&H00E1E1E1,&H00E1E1E1,&H00202020,&H70000000,0,0,0,0,100,100,1,0,1,1,0,7,64,64,46,1
Style: Title,DejaVu Sans,72,&H00FFFFFF,&H00FFFFFF,&H00202020,&H70000000,-1,0,0,0,100,100,1,0,1,2,0,5,100,100,0,1
[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
'''
groups=[];g=[]
for w in words:
 g.append(w)
 if len(g)>=7 or w['text'].endswith(('.', '?','!')):
  groups.append(g);g=[]
if g:groups.append(g)
def subtitles(start,end,label,kind):
 s=HEADER
 for g in groups:
  if g[-1]['end']<start or g[0]['start']>=end:continue
  for i,w in enumerate(g):
   a=max(start,g[0]['start'] if i==0 else w['start']);z=min(end,g[i+1]['start'] if i+1<len(g) else g[-1]['end']+.1)
   if z<=a:continue
   text=' '.join((r'{\c&H8FE9E4&}'+x['text']+r'{\c&HFFFFFF&}') if j==i else x['text'] for j,x in enumerate(g))
   s+=f'Dialogue: 0,{ass_time(a-start)},{ass_time(z-start)},Caption,,0,0,0,,{text}\n'
 if label:s+=f'Dialogue: 1,0:00:00.00,{ass_time(end-start)},Source,,0,0,0,,{label}\n'
 if start==0:s+='Dialogue: 2,0:00:02.00,0:00:07.00,Title,,0,0,0,,{\\pos(960,225)\\fad(500,700)}TRAVIS WALTON\\N{\\fs32}CINCO DÍAS FUERA DEL MUNDO\n'
 return s
def asset(name):
 if name.startswith('ia') and name.endswith('p'):
  return ROOT/'plates'/f'{name[:-1]}.png','still','Recreación de IA'
 if name.startswith('ia'):return ROOT/'motion'/f'{name}.mp4','motion','Recreación de IA'
 if name=='walton':return ROOT/'archive/walton-2019.jpg','portrait','Travis Walton · 2019 | SMG2019 · CC BY-SA 4.0'
 if name=='forest':return ROOT/'archive/apache-sitgreaves-2018.jpg','still','Apache-Sitgreaves · 2018 | USDA · Dominio público'
 return ROOT/'stock'/f'pexels-video-{name}.mp4','stock','Imágenes de apoyo'
# A revisited reconstruction marks a return to the same part of the narrative.
# Each fixed AI shot uses no more than its ten paid seconds. Other shots distribute the chapter's remaining duration.
plans=[
 [('ia01',10),('ia02',7),('ia03',7),('ia04',4),('ia08',7),('34504411',1),('walton',1),('11376802',1)],
 [('forest',1),('27911377',1),('ia01',10),('ia03',10),('28776269',1),('forest',1)],
 [('ia02',8),('ia04',6),('ia08',8),('28777052',1),('ia05',10),('ia08p',1)],
 [('ia05',10),('28777271',1),('28776269',1),('forest',1),('18138981',1)],
 [('ia06',10),('33650283',1),('ia06p',1),('34504411',1),('7528630',1)],
 [('ia07',10),('ia07p',1),('5818973',1),('walton',1),('ia07p',1),('28777052',1)],
 [('33068304',1),('34187599',1),('walton',1),('7969842',1),('10719866',1)],
 [('34504411',1),('forest',1),('walton',1),('33068304',1),('8477872',1)],
 [('walton',1),('ia07',10),('ia07p',1),('34504411',1),('28776269',1),('ia02p',1)],
 [('33068304',1),('walton',1),('18138981',1),('forest',1),('7528630',1),('28777271',1)],
 [('ia08',10),('ia01',8),('ia03',8),('ia08p',1),('34504411',1),('28777052',1)],
 [('walton',1),('forest',1),('10719866',1),('ia08p',1)]
]
shots=[];frame=0;usage={}
for chapter,plan in zip(chapters,plans):
 endframe=round(chapter['end']*FPS);remaining=(endframe-frame)/FPS
 fixed=sum(v for n,v in plan if asset(n)[1]=='motion');flex=sum(1 for n,v in plan if asset(n)[1]!='motion')
 if remaining<=fixed:raise RuntimeError('invalid fixed shot lengths')
 for k,(name,length) in enumerate(plan):
  src,kind,label=asset(name)
  sec=length if kind=='motion' else (remaining-fixed)/flex
  frames=(endframe-frame) if k==len(plan)-1 else round(sec*FPS)
  start=frame/FPS;end=(frame+frames)/FPS
  idx=len(shots);count=usage.get(name,0);usage[name]=count+1
  shots.append({'index':idx,'asset':name,'src':str(src),'kind':kind,'label':label,'start':start,'end':end,'frames':frames,'use':count})
  frame+=frames
(OUT/'timeline.json').write_text(json.dumps(shots,ensure_ascii=False,indent=2))
def render(shot):
 idx=shot['index'];out=OUT/f'shot-{idx:03}.mp4'
 if out.exists() and out.stat().st_size>10000:return idx
 start=shot['start'];end=shot['end'];length=end-start;src=Path(shot['src']);kind=shot['kind']
 if not src.exists():return None
 ass=OUT/f'shot-{idx:03}.ass';ass.write_text(subtitles(start,end,shot['label'],kind))
 args=['ffmpeg','-v','error','-y','-threads','2','-filter_threads','1']
 if kind in ('still','portrait'):args+=['-loop','1','-framerate',str(FPS),'-i',str(src)]
 else:
  d=duration(src);offset=min(max(0,d-length-.15),shot['use']*6)
  args+=['-ss',str(offset),'-i',str(src)]
 filters=[f'scale={W}:{H}:force_original_aspect_ratio=decrease',f'pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=0x101719','setsar=1',f'fps={FPS}']
 if kind not in ('still','portrait'):
  filters.insert(0,f'setpts={max(1,length/duration(src)):.6f}*(PTS-STARTPTS)')
 filters+=[f'ass={ass}']
 args+=['-vf',','.join(filters),'-frames:v',str(shot['frames']),'-an','-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-threads','2',str(out)]
 run(args);print('SHOT',idx,flush=True);return idx
if sys.argv[-1]=='plan':print('PLAN',len(shots),'shots',TOTAL,'seconds');sys.exit()
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:results=list(pool.map(render,shots))
if any(x is None for x in results):
 print('Waiting for motion assets. Available shots rendered.');sys.exit()
(OUT/'concat.txt').write_text(''.join(f"file '{OUT}/shot-{s['index']:03}.mp4'\n" for s in shots))
run(['ffmpeg','-v','error','-y','-f','concat','-safe','0','-i',str(OUT/'concat.txt'),'-i',str(ROOT/'Travis-Walton-podcast-Hans.mp3'),'-map','0:v','-map','1:a','-c:v','copy','-c:a','aac','-b:a','192k','-t',str(TOTAL),'-movflags','+faststart',str(ROOT/'Travis-Walton-montaje-narrado-1080p.mp4')])
print('VIDEO_READY',TOTAL,flush=True)
