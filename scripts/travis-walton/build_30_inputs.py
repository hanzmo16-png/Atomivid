"""Create a 30-minute input mix/timeline. This never renders the episode video."""
from pathlib import Path
import copy,hashlib,json,math,re,subprocess,sys,wave

ROOT=Path(sys.argv[1]).resolve();BASE=ROOT/'entrada';MEDIA=BASE/'medios';FPS=25;SR=48000
original=json.loads((ROOT/'v4.json').read_text());voice=json.loads((ROOT/'voice.json').read_text());stocks=json.loads((ROOT/'stocks.json').read_text())
assert original['assembly_version']==4 and voice['targetVersion']==5 and voice['targetSeconds']==1800
old_total=round(original['expected_total_seconds']*FPS)/FPS;extra=1800-old_total
assert old_total==813.92 and len(voice['blocks'])==8
manifest=copy.deepcopy(original);files={f['id']:f for f in manifest['files']}
def digest(p):
    h=hashlib.sha256()
    with open(p,'rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
    return h.hexdigest()
def ff(*args):
    p=subprocess.run(['ffmpeg','-nostdin','-hide_banner','-v','error','-y',*map(str,args)],capture_output=True)
    if p.returncode:raise RuntimeError(p.stderr.decode(errors='replace')[-2500:])
    return p.stdout
def probe(p):
    return json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(p)]))
def seconds(p):return float(probe(p)['format']['duration'])
def add_file(fid,path,role):
    f={'id':fid,'path':str(path.relative_to(BASE)),'size':path.stat().st_size,'sha256':digest(path),'role':role}
    if fid in files:manifest['files'][manifest['files'].index(files[fid])]=f
    else:manifest['files'].append(f)
    files[fid]=f;return f

words0=json.loads((BASE/files['asset_30']['path']).read_text());words0=words0.get('words',[]) if isinstance(words0,dict) else words0
words0=[w for w in words0 if w['start']<old_total]
for w in words0:w['end']=min(w['end'],old_total)
chapters=copy.deepcopy(original['chapters']);boundaries={}
for b in voice['blocks']:
    target=next(c['end'] for c in chapters if c['id']==b['afterChapter'])
    gaps=[]
    for a,z in zip(words0,words0[1:]):
        low=math.ceil((a['end']+.008)*FPS);high=math.floor((z['start']-.008)*FPS)
        if low<=high and abs((a['end']+z['start'])/2-target)<1.25:
            at=min(high,max(low,round(target*FPS)));gaps.append((abs(at/FPS-target),at/FPS))
    if not gaps:raise RuntimeError('No safe silent chapter splice near '+b['afterChapter'])
    boundaries[b['id']]=min(gaps)[1]
for i,c in enumerate(chapters):
    insert=next((b for b in voice['blocks'] if b['afterChapter']==c['id']),None)
    if insert:
        c['end']=boundaries[insert['id']]
        if i+1<len(chapters):chapters[i+1]['start']=c['end']
chapters[-1]['end']=old_total

# Measure decoded sample lengths instead of trusting MP3 container padding.
durations=[]
for b in voice['blocks']:
    out=ROOT/f"{b['id']}-decoded.wav"
    ff('-i',ROOT/'narration'/f"{b['id']}.mp3",'-ar',SR,'-ac',2,'-c:a','pcm_s16le',out)
    with wave.open(str(out),'rb') as w:durations.append(w.getnframes()/SR)
tempo=sum(durations)/extra
if not .90<=tempo<=1.12:raise RuntimeError(f'Natural-pacing guard: tempo {tempo:.6f} outside .90–1.12')
cum=0;previous=0;insertions=[]
for b,d in zip(voice['blocks'],durations):
    cum+=d;end=round(cum/sum(durations)*round(extra*FPS));frames=end-previous;previous=end
    insertions.append({**b,'oldAt':boundaries[b['id']],'frames':frames,'duration':frames/FPS,'tempo':d/(frames/FPS)})
assert sum(x['frames'] for x in insertions)==round(extra*FPS)

old_audio=BASE/files['asset_29']['path'];old_wav=ROOT/'original.wav'
ff('-i',old_audio,'-ar',SR,'-ac',2,'-c:a','pcm_s16le',old_wav)
measurement=subprocess.run(['ffmpeg','-nostdin','-hide_banner','-i',str(old_audio),'-af','loudnorm=I=-16:TP=-1.5:LRA=8:print_format=json','-f','null','-'],capture_output=True,check=True)
loud=json.loads(re.findall(r'\{[^{}]+\}',measurement.stderr.decode())[-1]);target_i=float(loud['input_i'])
if not -24<=target_i<=-12:raise RuntimeError('Unexpected original integrated loudness')
tracks=['tension-1','tension-2','tension-1','reflective-1','cinematic-2','reflective-1','reflective-1','cinematic-2']
new_words=[];offset=0
for b,track in zip(insertions,tracks):
    b['start']=b['oldAt']+offset;b['end']=b['start']+b['duration'];offset+=b['duration']
    n=round(b['duration']*SR);v=ROOT/f"{b['id']}-paced.wav";mix=ROOT/f"{b['id']}-mix.wav"
    ff('-i',ROOT/f"{b['id']}-decoded.wav",'-af',f"atempo={b['tempo']:.12f},loudnorm=I={target_i}:TP=-2:LRA=8,aresample={SR},apad=whole_len={n},atrim=end_sample={n}",'-ac',2,'-c:a','pcm_s16le',v)
    music=ROOT/'music'/f'elevenlabs-{track}.mp3'
    filt=f"[1:a]loudnorm=I=-29:TP=-4:LRA=7,aresample={SR},afade=t=in:d=1.5,afade=t=out:st={b['duration']-1.5}:d=1.5,volume=0.65[m];[0:a][m]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.89:level=false:latency=true,atrim=end_sample={n}[a]"
    ff('-i',v,'-stream_loop','-1','-i',music,'-filter_complex',filt,'-map','[a]','-ar',SR,'-ac',2,'-c:a','pcm_s16le',mix)
    with wave.open(str(mix),'rb') as w:assert w.getnframes()==n
    for w in b['words']:
        a=b['start']+w['startSeconds']/b['tempo'];z=min(b['end'],b['start']+w['endSeconds']/b['tempo'])
        if a>=z:raise RuntimeError('New word outside its complete narration')
        new_words.append({'text':w['text'],'start':a,'end':z})

# Copy the original PCM in order, inserting only in verified inter-word gaps.
master=ROOT/'thirty-mix.wav';cursor=0;old_samples_copied=0
with wave.open(str(old_wav),'rb') as old,wave.open(str(master),'wb') as out:
    out.setparams((2,2,SR,0,'NONE','not compressed'))
    for b in insertions:
        stop=round(b['oldAt']*SR);old.setpos(cursor);chunk=old.readframes(stop-cursor)
        assert len(chunk)==(stop-cursor)*4;out.writeframes(chunk);old_samples_copied+=stop-cursor;cursor=stop
        with wave.open(str(ROOT/f"{b['id']}-mix.wav"),'rb') as new:
            while data:=new.readframes(SR*10):out.writeframes(data)
    stop=round(old_total*SR);old.setpos(cursor);chunk=old.readframes(stop-cursor);assert len(chunk)==(stop-cursor)*4
    out.writeframes(chunk);old_samples_copied+=stop-cursor
assert old_samples_copied==round(old_total*SR)
with wave.open(str(master),'rb') as w:assert w.getnframes()==1800*SR
new_audio=MEDIA/'29-Travis-Walton-podcast-Hans-30min.mp3'
ff('-i',master,'-c:a','libmp3lame','-b:a','192k','-id3v2_version',3,'-metadata','title=Travis Walton: cinco días fuera del mundo — 30 minutos','-metadata','artist=Hans Moreno',new_audio)
add_file('asset_29',new_audio,'mezcla_final')
for w in words0:
    shift=sum(b['duration'] for b in insertions if w['start']>=b['oldAt'])
    assert not any(w['start']<b['oldAt']<w['end'] for b in insertions)
    new_words.append({'text':w['text'],'start':w['start']+shift,'end':w['end']+shift})
new_words.sort(key=lambda w:w['start']);assert all(a['start']<=z['start'] for a,z in zip(new_words,new_words[1:]))
word_path=MEDIA/'30-words-30min.json';word_path.write_text(json.dumps(new_words,ensure_ascii=False,indent=2)+'\n');add_file('asset_30',word_path,'subtitles_words')

# Split original visuals only at the insertion boundaries, preserving source speed.
pieces=[];cursor_frames=0
for shot in original['timeline']:
    start_frame=cursor_frames;end_frame=start_frame+round(shot['duration']*FPS);cursor_frames=end_frame
    # Compare frame integers: floating accumulation at an exact boundary used to
    # create a phantom zero-frame splice (for example 397.079999999 vs 397.08).
    cuts=[start_frame]+[round(b['oldAt']*FPS) for b in insertions if start_frame<round(b['oldAt']*FPS)<end_frame]+[end_frame]
    for k,(a_frame,z_frame) in enumerate(zip(cuts,cuts[1:])):
        assert z_frame>a_frame
        a=a_frame/FPS;z=z_frame/FPS;start=start_frame/FPS;end=end_frame/FPS
        s=copy.deepcopy(shot);s['duration']=(z_frame-a_frame)/FPS
        if len(cuts)>2:s['id']+='_splice_'+str(k)
        if s['type'] in ('broll','animation','avatar') and (a_frame!=start_frame or z_frame!=end_frame):
            speed=(shot['out']-shot.get('in',0))/shot['duration'] if shot.get('insuficiente',{}).get('modo')=='ajustar_velocidad' else 1
            s['in']=shot.get('in',0)+(a-start)*speed;s['out']=s['in']+s['duration']*speed
        shift_frames=sum(b['frames'] for b in insertions if a_frame>=round(b['oldAt']*FPS))
        pieces.append((a_frame+shift_frames,s))

for i,s in enumerate(stocks):
    fid='stock_'+s['sourceId'].split('-')[-1];path=MEDIA/(s['sourceId']+'.mp4');s['fid']=fid;s['decodedDuration']=seconds(path)
    add_file(fid,path,'broll')
    ff('-ss',min(3,s['decodedDuration']/2),'-i',path,'-frames:v',1,'-vf',f"scale=384:216:force_original_aspect_ratio=decrease,pad=384:216:(ow-iw)/2:(oh-ih)/2,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='{i+1} - {s['sourceId'].split('-')[-1]}':x=12:y=12:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.7",ROOT/f'stock-{i:02}.jpg')

def stock(i):return stocks[i]['fid']
# More moving footage than stills; all stock remains explicitly illustrative.
pools=[
 [stock(i) for i in [0,1,2,3]]+['asset_17','asset_18'],
 ['asset_16','asset_18','asset_19','asset_20',stock(0),stock(4),stock(5),stock(6)],
 [stock(i) for i in [4,5,6,1,3,7,9]]+['asset_17','asset_22'],
 [stock(i) for i in [10,7,8,9,16,17]]+['asset_24','asset_22','asset_15'],
 ['asset_21','asset_23','asset_27',stock(7),stock(8),stock(9),stock(16),stock(17),'asset_25'],
 [stock(i) for i in [7,8,9,16,17,0,1,2]]+['asset_21','asset_23','asset_27'],
 [stock(i) for i in [13,14,18,19,7,8,9,16,17]]+['asset_24','asset_27'],
 [stock(i) for i in [11,12,15,13,14,18,19]]+['asset_26','asset_28'],
]
usage={};stock_durations={s['fid']:s['decodedDuration'] for s in stocks};repeated=[]
for j,(b,pool) in enumerate(zip(insertions,pools)):
    remaining=b['frames'];position=round(b['start']*FPS);index=0
    # Chapter title is brief and over the moving first shot, never a black card.
    while remaining:
        candidates=[]
        for rank,fid in enumerate(pool):
            if fid not in stock_durations:stock_durations[fid]=seconds(BASE/files[fid]['path'])
            used=usage.get(fid,0.0);avail=math.floor((stock_durations[fid]-.16-used)*FPS)
            if avail>=min(remaining,3*FPS):candidates.append((used/max(1,stock_durations[fid]),rank,fid,avail))
        if not candidates:
            # Deliberate revisit of illustrative stock, never a freeze or slow-down.
            fid=min(pool,key=lambda f:usage.get(f,0)/stock_durations[f]);usage[fid]=0;repeated.append({'section':b['id'],'source':fid});continue
        _,_,fid,available=min(candidates);frames=min(remaining,available,10*FPS)
        if 0<remaining-frames<3*FPS and available>=remaining:frames=remaining
        at=usage.get(fid,0);duration=frames/FPS
        s={'id':f"{b['id']}_shot_{index:03}",'type':'broll','source':fid,'duration':duration,'in':at,'out':at+duration,'fit':'contain','fit_mode':'trim','use_audio':False,'label':('Imágenes de apoyo · no son archivo del caso' if index else b['title']+' | Imágenes de apoyo')}
        pieces.append((position,s));position+=frames;remaining-=frames;usage[fid]=at+duration;index+=1
    assert position==round(b['end']*FPS)
pieces.sort(key=lambda x:x[0]);cursor=0
for at,s in pieces:assert at==cursor,(at,cursor,s['id']);cursor+=round(s['duration']*FPS)
assert cursor==45000
manifest['timeline']=[s for _,s in pieces];manifest['assembly_version']=5;manifest['expected_total_seconds']=1800
new_chapters=[];offset=0
for c in chapters:
    new_chapters.append({**c,'start':c['start']+offset,'end':c['end']+offset})
    b=next((b for b in insertions if b['afterChapter']==c['id']),None)
    if b:
        new_chapters.append({'id':b['id'],'title':b['title'],'start':b['start'],'end':b['end']});offset+=b['duration']
manifest['chapters']=new_chapters
assert len(new_chapters)==20 and abs(new_chapters[-1]['end']-1800)<.001
assert sum(s['type']=='avatar' for s in manifest['timeline'])==4
manifest['_estado_editorial']='Entrada ampliada de 30 minutos; pendiente de montaje, revisión y publicación por Grok.'
manifest['_expansion']={'originalSeconds':old_total,'addedSeconds':extra,'originalPcmSamplesPreserved':old_samples_copied,'voiceTempo':tempo,'briefing':'Keep sources illustrative; no new paid media. Verify 1800 seconds and complete subtitles.'}
# Historical credits retained, clearly labeled as the preserved short-edit record.
for source in manifest.get('sources_credits',{}).get('sources',[]):
    if isinstance(source.get('text'),str):source['text']='REGISTRO DE LA VERSIÓN CORTA CONSERVADA; LOS TIEMPOS DE ABAJO SON HISTÓRICOS.\n'+source['text']
extra_credits='AMPLIACIÓN V5 — 30:00\nOcho secciones nuevas. Valoración adicional de voz: USD 3.1288 aprox.; consultar ledger para redondeo. Sin nuevas generaciones pagadas de imágenes o avatar.\nNuevos videos: imágenes ilustrativas, no archivo del caso. Pexels License https://www.pexels.com/license/\n'
extra_credits+='\n'.join(f"{s.get('photographer','Pexels')} — {s.get('pageUrl','')}" for s in stocks)
extra_credits+='\nFuentes adicionales: https://www.fs.usda.gov/r03/apache-sitgreaves ; https://www.debunker.com/historical/WaltonMisc.pdf ; https://www.debunker.com/historical/KlassContraWalton.pdf ; https://www.nationalacademies.org/read/18891/chapter/6 ; https://nap.nationalacademies.org/skim.php?chap=1-10&record_id=10420 ; https://science.nasa.gov/uap/faqs/\nCAPÍTULOS ACTUALES\n'
extra_credits+='\n'.join(f"{int(c['start'])//60:02}:{int(c['start'])%60:02} — {c['title']}" for c in new_chapters)
manifest['sources_credits']['sources'].append({'text':extra_credits})
data=(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode();(BASE/'montaje.json').write_bytes(data)
(BASE/'LISTO.json').write_text(json.dumps({'episode_id':manifest['episode_id'],'assembly_version':5,'manifest_sha256':hashlib.sha256(data).hexdigest(),'file_count':len(manifest['files'])},indent=2)+'\n')

# Review thumbnails and short voice excerpts are private encrypted exports.
inputs=[]
for i in range(len(stocks)):inputs+=['-i',str(ROOT/f'stock-{i:02}.jpg')]
layout='|'.join(f'{i%4*384}_{i//4*216}' for i in range(len(stocks)))
ff(*inputs,'-filter_complex_threads',1,'-filter_complex',f'xstack=inputs={len(stocks)}:layout={layout}', '-frames:v',1,ROOT/'stock-sheet.jpg')
samples=[]
for b in insertions:
    p=ROOT/f"sample-{b['id']}.wav";ff('-ss',2,'-i',ROOT/f"{b['id']}-mix.wav",'-t',6,'-c:a','pcm_s16le',p);samples.append(p)
(ROOT/'samples.txt').write_text(''.join(f"file '{p}'\n" for p in samples))
ff('-f','concat','-safe',0,'-i',ROOT/'samples.txt','-c:a','libmp3lame','-b:a','128k',ROOT/'voice-sample.mp3')
report={'episodeId':manifest['episode_id'],'version':5,'seconds':1800,'frames':45000,'sourceSeconds':old_total,'addedSeconds':extra,'newVoiceRawSeconds':sum(durations),'newVoiceTempo':tempo,'originalPcmSamplesPreserved':old_samples_copied,'segments':len(pieces),'avatarSegments':4,'chapters':len(new_chapters),'files':len(manifest['files']),'words':len(new_words),'lastWordEnd':new_words[-1]['end'],'originalIntegratedLufs':target_i,'newStockFiles':len(stocks),'revisitedStockWindows':repeated,'manifestSha256':hashlib.sha256(data).hexdigest(),'inputBytes':sum(f['size'] for f in manifest['files']),'insertionSplices':[{'id':b['id'],'oldAt':b['oldAt'],'start':b['start'],'end':b['end']} for b in insertions]}
(ROOT/'preparation-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
