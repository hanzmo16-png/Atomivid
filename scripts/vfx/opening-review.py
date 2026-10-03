"""Private five-second motion/integration proof. Not a master or final-plate replacement."""
import hashlib,json,pathlib,subprocess,sys,warnings,zipfile
import numpy as np
from PIL import Image,ImageFilter
from scipy.ndimage import distance_transform_edt
from sequence_pixels import composite

def main():
 root=pathlib.Path(sys.argv[1]);native=len(sys.argv)>2 and sys.argv[2]=='native';sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
 mr=json.loads((root/'matte-report.json').read_text());parts=[]
 for part in mr['matteParts']:
  path=root/part['file']
  if sha(path)!=part['sha256']:raise ValueError('VFX_MATTE_CHANGED')
  with np.load(path,allow_pickle=False) as a:parts.append(a['alpha'])
 matte=np.concatenate(parts);del parts
 if matte.shape!=(150,1920,1080) or matte.dtype!=np.uint8:raise ValueError('VFX_MATTE_ALIGNMENT_CHANGED')
 samples=[]
 for n in (25,75,125):
  raw=subprocess.check_output(['ffmpeg','-v','error','-i',str(root/'source.mp4'),'-vf',f'select=eq(n\\,{n})','-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','-'])
  samples.append(np.frombuffer(raw,np.uint8).reshape(1920,1080,3).astype(np.float32)/255)
 samples=np.stack(samples);valid=np.stack([matte[n]<5 for n in (25,75,125)]);samples[~valid]=np.nan
 with warnings.catch_warnings():warnings.simplefilter('ignore',RuntimeWarning);room=np.nanmedian(samples,axis=0)
 missing=~np.isfinite(room).all(-1);nearest=distance_transform_edt(missing,return_distances=False,return_indices=True);room[missing]=room[tuple(nearest[:,missing])];del samples
 source=subprocess.Popen(['ffmpeg','-v','error','-i',str(root/'source.mp4'),'-frames:v','150','-pix_fmt','rgb24','-f','rawvideo','-'],stdout=subprocess.PIPE)
 decoder=lambda p:subprocess.Popen(['ffmpeg','-v','error','-i',str(p),'-vf','fps=30:round=near'+('' if native else ',scale=1080:1920:flags=lanczos'),'-frames:v','50','-pix_fmt','rgb24','-f','rawvideo','-'],stdout=subprocess.PIPE)
 plate_processes={0:decoder(root/'nyc-region-proof.mp4'),1:decoder(root/'beach.mp4')}
 moon=np.array(Image.open(root/'flag.png').convert('RGB').filter(ImageFilter.GaussianBlur(2.5))).astype(np.float32)/255
 settings=[([.82,.90,1.02],[0,.004,.016],1.),([.99,1.02,1.04],[.007,.007,.007],1.8),([.94,.96,.99],[-.012,-.012,-.012],2.5)]
 fields=[]
 for w,(rgb,b,_) in enumerate(settings):
  gain=np.broadcast_to(np.array(rgb,np.float32),(1920,1080,3)).copy();bias=np.broadcast_to(np.array(b,np.float32),gain.shape).copy()
  if w==2:gain*=np.linspace(1.09,.81,1080,dtype=np.float32)[None,:,None]
  fields.append((gain,bias))
 output=root/('ATOMIVID-apertura-nativa-revision.mp4' if native else 'ATOMIVID-apertura-prueba.mp4');encoder=subprocess.Popen(['ffmpeg','-v','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s','1080x1920','-r','30','-i','-','-an','-c:v','libx264','-crf','18','-preset','fast','-pix_fmt','yuv420p','-movflags','+faststart',str(output)],stdin=subprocess.PIPE)
 interior=0;maxdiff=0
 try:
  for i in range(150):
   def frame(proc):
    raw=proc.stdout.read(1920*1080*3)
    if len(raw)!=1920*1080*3:raise ValueError('VFX_REVIEW_MEDIA_SHORT')
    return np.frombuffer(raw,np.uint8).reshape(1920,1080,3)
   s=frame(source).astype(np.float32)/255;w=i//50
   if w<2:p=np.array(Image.fromarray(frame(plate_processes[w])).filter(ImageFilter.GaussianBlur(settings[w][2]))).astype(np.float32)/255
   else:p=moon
   alpha=matte[i].astype(np.float32)/255;gain,bias=fields[w];image=np.rint(composite(s,p,alpha,room,gain,bias)*255).astype(np.uint8);mask=alpha==1
   expected=np.rint(np.clip(s*gain+bias,0,1)*255).astype(np.uint8)
   if mask.any():maxdiff=max(maxdiff,int(np.abs(image[mask].astype(np.int16)-expected[mask].astype(np.int16)).max()));interior+=int(mask.sum())
   encoder.stdin.write(image.tobytes())
  encoder.stdin.close()
  if encoder.wait() or source.wait() or any(p.wait() for p in plate_processes.values()):raise ValueError('VFX_REVIEW_CODEC_FAILED')
 finally:
  for p in [encoder,source,*plate_processes.values()]:
   if p.poll() is None:p.kill()
   p.wait()
 if not interior or maxdiff:raise ValueError('VFX_REVIEW_SUBJECT_LOCK_FAILED')
 report=dict(stage='private-opening-review',sourceSha256=mr['sourceSha256'],sha256=sha(output),width=1080,height=1920,frames=150,fps=30,seconds=5,worlds=['nyc','beach','moon-fixed-flag'],cutsAtFrames=[50,100],subjectInteriorPixels=interior,subjectMaxDifferenceBeforeEncoding=maxdiff,geometricWarp=False,grainPasses=0,audio=False,providerCalls=0,additionalUsd=0,motionApproved=False,integrationApproved=False,productionReady=False,limitations=['NYC and beach 720 preview plates resized deterministically for this proof only; final native 1080 material remains required','No physical hard-sun relighting certification; actual foreground reflections, edges and contact need review','This is the five-second opening only; campaign UI/voice/music/captions/closing are not assembled here'])
 if native:
  report['stage']='private-native-opening-review';report['nativeBackgrounds']=True
  report['limitations']=report['limitations'][1:]
  report['nycCorrection']=json.loads((root/'nyc-native-region-report.json').read_text())
 (root/'opening-review.json').write_text(json.dumps(report,indent=2)+'\n')
 with zipfile.ZipFile(root/'opening-review.zip','w',zipfile.ZIP_DEFLATED) as z:
  z.write(output,output.name);z.write(root/'opening-review.json','opening-review.json')
 print(json.dumps(report))
if __name__=='__main__':main()
