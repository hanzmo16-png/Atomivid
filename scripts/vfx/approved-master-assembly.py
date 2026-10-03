"""Local replay-only master. Config/media and diagnostics stay private; no network calls."""
import pathlib,json,subprocess,hashlib,sys,re
cfg=json.loads(pathlib.Path(sys.argv[1]).read_text());root=pathlib.Path(cfg['outputDirectory']);work=root/'work';work.mkdir(parents=True,exist_ok=True)
def run(args):
 p=subprocess.run(args,capture_output=True,text=True)
 if p.returncode: (work/'failure.txt').write_text(p.stderr);raise RuntimeError('LOCAL_ASSEMBLY_FAILED')
 return p.stdout

def ff(args): return run(['ffmpeg','-hide_banner','-v','error','-y','-threads','4','-filter_complex_threads','2',*map(str,args)])
def probe(p): return json.loads(run(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(p)]))
def sha(p): return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
for a in cfg['verifiedAssets']: assert sha(a['path'])==a['sha256'],'APPROVED_ASSET_CHANGED'
assert cfg['paidCalls']==0 and cfg['ownerApprovedTakes'] is True
enc=['-an','-c:v','libx264','-crf','17','-preset','fast','-pix_fmt','yuv420p','-r','30','-threads','4']
old=cfg['previousMaster'];native=cfg['opening'];closing=cfg['closing'];brand=pathlib.Path(cfg['brandDirectory']);segments=[]
def segment(name,inputs,filter,frames):
 p=work/(name+'.mp4');ff([*inputs,'-filter_complex',filter,'-map','[v]','-frames:v',frames,*enc,p]);segments.append(p);assert int(next(s for s in probe(p)['streams'] if s['codec_type']=='video')['nb_frames'])==frames
segment('intro',['-i',old],'[0:v]trim=start_frame=0:end_frame=66,setpts=PTS-STARTPTS,setsar=1[v]',66)
segment('approved-opening',['-i',native],'[0:v]trim=start_frame=0:end_frame=150,setpts=PTS-STARTPTS,setsar=1[v]',150)
segment('avatar',['-i',cfg['avatar'],'-i',brand/'ui-idea.mp4'],'[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,setsar=1,tpad=stop_mode=clone:stop_duration=1[av];[1:v]fps=30,setsar=1,format=yuva420p,fade=t=in:st=0:d=0.2:alpha=1,setpts=PTS-STARTPTS+1.12/TB[ui];[av][ui]overlay=eof_action=repeat:format=auto,format=yuv420p[v]',114)
segment('demo-results',['-i',old],'[0:v]trim=start_frame=318:end_frame=618,setpts=PTS-STARTPTS,setsar=1[v]',300)
segment('reveal',['-i',brand/'ui-reveal.mp4'],'[0:v]fps=30,setsar=1,tpad=stop_mode=clone:stop_duration=1[v]',153)
segment('approved-closing',['-i',closing],'[0:v]trim=start_frame=0:end_frame=246,setpts=PTS-STARTPTS,setsar=1[v]',246)
segment('end',['-i',brand/'end-card.mp4'],'[0:v]fps=30,setsar=1[v]',45)
concat=work/'concat.txt';concat.write_text('\n'.join("file '"+str(p)+"'" for p in segments));picture=work/'picture.mp4';ff(['-f','concat','-safe','0','-i',concat,'-c','copy',picture])
# Full opening speech and all persisted narration; approved closing waveform is used whole.
voicechain=cfg['openingVoiceChain']
openingWav=work/'opening.wav';ff(['-ss','2.5','-t','7.2','-i',cfg['openingOriginal'],'-vn','-af',voicechain+',volume=3.8dB','-ar','48000','-ac','2',openingWav])
inputs=['-i',openingWav];chains=['[0:a]apad=whole_dur=35.8,atrim=0:35.8[a0]'];audio=[(x['path'],x['start'],x['gainDb']) for x in cfg['tts']]+[(closing,26.1,cfg['closingGainDb'])]
for i,(p,start,gain) in enumerate(audio,1):
 inputs+=['-i',p];ms=round(start*1000);chains.append(f'[{i}:a]aresample=48000,aformat=channel_layouts=stereo,volume={gain}dB,adelay={ms}|{ms}[a{i}]')
voice=work/'voice.wav';ff([*inputs,'-filter_complex',';'.join(chains)+';'+''.join(f'[a{i}]' for i in range(6))+'amix=inputs=6:normalize=0:duration=first[v]','-map','[v]','-ar','48000','-ac','2',voice])
# Captions are only added over new shots: the replayed body already carries its captions.
def stamp(t):
 cs=round(t*100);return f'{cs//360000}:{cs//6000%60:02}:{cs//100%60:02}.{cs%100:02}'
events=[]
for c in cfg['captionChunks']:
 assert c['end']>c['start']>=0 and c['end']<=35.8
 text=c['text'].upper().replace('{','').replace('}','').replace('\n',' ')
 events.append(f"Dialogue: 0,{stamp(c['start'])},{stamp(c['end'])},Cap,,0,0,0,,{text}")
ass=work/'captions.ass';ass.write_text('[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Cap,Anton,80,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,1,0,1,6,2,2,140,160,560,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'+'\n'.join(events)+'\n')
# One global grain pass; a single continuous existing licensed instrumental, ducked by speech.
mix=work/'mix.wav';ff(['-i',voice,'-stream_loop','-1','-i',cfg['music'],'-filter_complex','[1:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:35.8,asetpts=PTS-STARTPTS,volume=0.22,afade=t=in:d=0.45,afade=t=out:st=34.3:d=1.5[m];[0:a]asplit=2[vo][sc];[m][sc]sidechaincompress=threshold=0.03:ratio=8:attack=15:release=280[md];[vo][md]amix=inputs=2:normalize=0:duration=first[a]','-map','[a]','-ar','48000',mix])
log=subprocess.run(['ffmpeg','-hide_banner','-nostats','-i',str(mix),'-af','loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json','-f','null','-'],capture_output=True,text=True).stderr
measurement=json.loads(log[log.rfind('{'):]);ln='loudnorm=I=-14:TP=-1.5:LRA=11:measured_I='+measurement['input_i']+':measured_TP='+measurement['input_tp']+':measured_LRA='+measurement['input_lra']+':measured_thresh='+measurement['input_thresh']+':offset='+measurement['target_offset']+':linear=true'
master=root/'ATOMIVID-precampana-master.mp4';ff(['-i',picture,'-i',mix,'-vf',f'subtitles={ass}:fontsdir={cfg["fontDirectory"]},noise=alls=1:allf=t:all_seed=29','-af',ln+',aresample=48000','-map','0:v','-map','1:a','-t','35.8','-c:v','libx264','-crf','18','-preset','medium','-threads','4','-pix_fmt','yuv420p','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-c:a','aac','-b:a','256k','-movflags','+faststart',master])
report={'sha256':sha(master),'probe':probe(master),'paidCalls':0,'additionalUsd':0,'grainPasses':1,'grainPlacement':'full-frame final export','openingFrames':150,'openingCutsAtMasterFrames':[116,166],'closingFrames':246,'closingStart':26.1,'musicSource':'existing licensed instrumental','ownerApprovedTakes':True,'masterOwnerReviewPending':True,'deployment':False,'sections':[{'name':n,'start':s,'duration':d} for n,s,d in [('opening',0,7.2),('avatar',7.2,3.8),('demo-results',11,10),('reveal',21,5.1),('closing',26.1,8.2),('end',34.3,1.5)]]}
# Export is released only after the actual encoded file passes technical gates.
def ff_log(args):
 return subprocess.run(['ffmpeg','-hide_banner','-nostats','-threads','4',*args,'-f','null','-'],capture_output=True,text=True).stderr
v=next(x for x in report['probe']['streams'] if x['codec_type']=='video');a=next(x for x in report['probe']['streams'] if x['codec_type']=='audio')
summary=ff_log(['-i',str(master),'-af','ebur128=peak=true']).split('Summary:')[-1]
i=float(re.search(r'I:\s+(-?[\d.]+) LUFS',summary)[1]);tp=float(re.search(r'Peak:\s+(-?[\d.]+) dBFS',summary)[1])
bl=ff_log(['-i',str(master),'-vf','blackdetect=d=0.25:pix_th=0.08','-an']);black=re.findall(r'black_start:([\d.]+) black_end:([\d.]+)',bl)
cs=sorted(cfg['captionChunks'],key=lambda x:x['start']);overlaps=sum(cs[j]['start']<cs[j-1]['end']-.001 for j in range(1,len(cs)))
report['qa']={'resolution1080x1920':(v['width'],v['height'])==(1080,1920),'fps30':v['avg_frame_rate']=='30/1','frames1074':int(v['nb_frames'])==1074,'audio48kStereo':a['sample_rate']=='48000' and a['channels']==2,'avDriftUnder40ms':abs(float(v['duration'])-float(a['duration']))<.04,'durationUnder36':float(report['probe']['format']['duration'])<=36,'loudnessAroundMinus14':abs(i+14)<=1,'truePeakUnderMinus1':tp<=-1,'noAccidentalBlack':not black,'captionsNoOverlap':overlaps==0}
report['audioMetrics']={'integratedLufs':i,'truePeakDbfs':tp};report['allTechnicalChecksPassed']=all(report['qa'].values())
(root/'assembly-report.json').write_text(json.dumps(report,indent=2))
if not report['allTechnicalChecksPassed']: master.rename(root/'BLOCKED-master.mp4');raise RuntimeError('MASTER_QA_BLOCKED')
print('LOCAL_MASTER_RENDERED_AND_VERIFIED')
