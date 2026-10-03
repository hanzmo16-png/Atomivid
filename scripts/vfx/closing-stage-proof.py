"""Zero-paid-call launch-stage proof. Actual speech selects trim; original voice is retained."""
import hashlib,json,pathlib,subprocess,sys,zipfile,warnings
import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt
from faster_whisper import WhisperModel
from sequence_pixels import composite
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'precampaign-teaser'))
from vfx002_matte import run_rvm

def main():
 root=pathlib.Path(sys.argv[1]);config=json.loads((root/'config.json').read_text());sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
 if sha(root/'original.mp4')!=config['sourceSha256'] or sha(root/'rvm.onnx')!='88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828':raise ValueError('VFX_CLOSING_INPUT_CHANGED')
 asr=WhisperModel('base',device='cpu',compute_type='int8',cpu_threads=4)
 segments,info=asr.transcribe(str(root/'original.mp4'),language='es',beam_size=5,word_timestamps=True,vad_filter=True)
 transcript=[dict(start=s.start,end=s.end,text=s.text,words=[dict(start=w.start,end=w.end,word=w.word,probability=w.probability) for w in s.words]) for s in segments]
 words=[w for s in transcript for w in s['words']];text=' '.join(s['text'] for s in transcript).lower()
 (root/'transcript.json').write_text(json.dumps(transcript,ensure_ascii=False,indent=2))
 if not words or 'comentarios' not in text or not ('prueba' in text or 'acceso' in text):raise ValueError('VFX_CLOSING_SPEECH_UNCONFIRMED')
 start=max(0,round((words[0]['start']-.25)*30)/30);end=min(13.6,round((words[-1]['end']+.45)*30)/30);frames=round((end-start)*30)
 if frames<60 or frames>450:raise ValueError('VFX_CLOSING_TRIM_INVALID')
 tone='zscale=tin=arib-std-b67:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,fps=30'
 subprocess.run(['ffmpeg','-v','error','-y','-ss',str(start),'-i',str(root/'original.mp4'),'-t',str(frames/30),'-vf',tone,'-an','-c:v','libx264','-crf','0','-preset','fast',str(root/'source.mp4')],check=True)
 alpha=run_rvm(str(root/'rvm.onnx'),str(root/'source.mp4'),ds=.4,size=(1080,1920))
 if alpha.shape!=(frames,1920,1080):raise ValueError('VFX_CLOSING_MATTE_ALIGNMENT')
 for i in range(0,frames,10):np.savez_compressed(root/f'matte-part-{i:03}.npz',alpha=alpha[i:i+10])
 samples=[];indices=[frames//5,frames//2,frames*4//5]
 for n in indices:
  raw=subprocess.check_output(['ffmpeg','-v','error','-i',str(root/'source.mp4'),'-vf',f'select=eq(n\\,{n})','-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','-'])
  samples.append(np.frombuffer(raw,np.uint8).reshape(1920,1080,3).astype(np.float32)/255)
 samples=np.stack(samples);samples[~np.stack([alpha[n]<5 for n in indices])]=np.nan
 with warnings.catch_warnings():warnings.simplefilter('ignore',RuntimeWarning);room=np.nanmedian(samples,axis=0)
 missing=~np.isfinite(room).all(-1);nearest=distance_transform_edt(missing,return_distances=False,return_indices=True);room[missing]=room[tuple(nearest[:,missing])];del samples
 plate=np.array(Image.open(root/'stage.png').convert('RGB')).astype(np.float32)/255
 source=subprocess.Popen(['ffmpeg','-v','error','-i',str(root/'source.mp4'),'-pix_fmt','rgb24','-f','rawvideo','-'],stdout=subprocess.PIPE)
 output=root/'closing-visual.mp4';encoder=subprocess.Popen(['ffmpeg','-v','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s','1080x1920','-r','30','-i','-','-frames:v',str(frames),'-an','-c:v','libx264','-crf','18','-preset','fast','-pix_fmt','yuv420p',str(output)],stdin=subprocess.PIPE)
 interior=0;delta=0;gain=np.ones((1920,1080,3),np.float32);bias=np.zeros_like(gain)
 try:
  for i in range(frames):
   raw=source.stdout.read(1920*1080*3)
   if len(raw)!=1920*1080*3:raise ValueError('VFX_CLOSING_SHORT_SOURCE')
   s=np.frombuffer(raw,np.uint8).reshape(1920,1080,3).astype(np.float32)/255
   # Subtle background-only pulse; neither subject geometry nor its facial pixels change.
   pulse=1+.018*np.sin(i/30*2*np.pi/4);p=np.clip(plate*pulse,0,1)
   image=np.rint(composite(s,p,alpha[i].astype(np.float32)/255,room,gain,bias)*255).astype(np.uint8);solid=alpha[i]==255
   if solid.any():delta=max(delta,int(np.abs(image[solid].astype(np.int16)-np.rint(s[solid]*255).astype(np.int16)).max()));interior+=int(solid.sum())
   if i in indices:Image.fromarray(image).save(root/f'closing-proof-{i}.png')
   encoder.stdin.write(image.tobytes())
  encoder.stdin.close()
  if encoder.wait() or source.wait():raise ValueError('VFX_CLOSING_CODEC_FAILED')
 finally:
  for p in (encoder,source):
   if p.poll() is None:p.kill()
   p.wait()
 if delta or not interior:raise ValueError('VFX_CLOSING_SUBJECT_CHANGED')
 final=root/'ATOMIVID-cierre-escenario-prueba.mp4'
 subprocess.run(['ffmpeg','-v','error','-y','-i',str(output),'-ss',str(start),'-i',str(root/'original.mp4'),'-map','0:v:0','-map','1:a:0','-t',str(frames/30),'-c:v','copy','-af','volume=-6dB,highpass=f=75,alimiter=limit=0.89:level=disabled','-c:a','aac','-b:a','192k','-movflags','+faststart',str(final)],check=True)
 report=dict(stage='closing-launch-stage-proof',sourceSha256=config['sourceSha256'],sha256=sha(final),trim=[start,end],frames=frames,fps=30,width=1080,height=1920,subjectInteriorPixels=interior,subjectMaxDifferenceBeforeEncoding=delta,voice='Original recorded voice, no conversion',music=False,grainPasses=0,providerCalls=0,additionalUsd=0,plateKind='Internal deterministic launch-stage graphic; preview only',sourceSpeechConfirmed=True,transcript=transcript,materialApproved=False,integrationApproved=False,deployment=False)
 (root/'closing-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
 with zipfile.ZipFile(root/'closing-review.zip','w',zipfile.ZIP_DEFLATED) as z:
  for p in [final,root/'closing-report.json',root/'stage.png',*sorted(root.glob('closing-proof-*.png'))]:z.write(p,p.name)
 print(json.dumps(dict(proofRendered=True,sourceSpeechConfirmed=True,frames=frames,subjectMaxDifferenceBeforeEncoding=delta,paidCalls=0)))
if __name__=='__main__':main()
