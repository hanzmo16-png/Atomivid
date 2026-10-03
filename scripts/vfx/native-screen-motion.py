"""Constrain a native Pro NYC plate to screen interiors. No providers or upscale."""
import hashlib,json,pathlib,subprocess,sys
import numpy as np
from scipy.signal import fftconvolve
from PIL import Image

def main():
 source,out,expected=sys.argv[1:];out=pathlib.Path(out);out.mkdir(parents=True,exist_ok=True)
 sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
 if sha(source)!=expected:raise ValueError('VFX_NATIVE_INPUT_CHANGED')
 info=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',source]))
 v=next(s for s in info['streams'] if s['codec_type']=='video')
 if v['width']!=1080 or v['height']!=1920 or v['avg_frame_rate']!='25/1' or any(s['codec_type']=='audio' for s in info['streams']):raise ValueError('VFX_NATIVE_FORMAT_CHANGED')
 h,w=1920,1080;mask=np.zeros((h,w),np.float32)
 regions=[(220,22,422,154),(270,435,394,561),(270,612,398,795)]
 for x0,y0,x1,y1 in regions:
  yy,xx=np.mgrid[y0:y1,x0:x1];edge=np.minimum.reduce([xx-x0,x1-1-xx,yy-y0,y1-1-yy]);mask[y0:y1,x0:x1]=np.clip(edge/12,0,1)
 decoder=subprocess.Popen(['ffmpeg','-v','error','-i',source,'-frames:v','150','-pix_fmt','rgb24','-f','rawvideo','-'],stdout=subprocess.PIPE)
 output=out/'nyc-region-proof.mp4';encoder=subprocess.Popen(['ffmpeg','-v','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s','1080x1920','-r','25','-i','-','-frames:v','150','-an','-c:v','libx264','-crf','0','-preset','fast',str(output)],stdin=subprocess.PIPE)
 base=None;changes=[];previous=None;scores=[];outside=0
 try:
  for i in range(150):
   raw=decoder.stdout.read(h*w*3)
   if len(raw)!=h*w*3:raise ValueError('VFX_NATIVE_SHORT_INPUT')
   frame=np.frombuffer(raw,np.uint8).reshape(h,w,3)
   if base is None:base=frame.copy()
   x0,y0,x1,y1,r=810,90,1020,525,42
   template=base[y0:y1,x0:x1].mean(axis=2);template-=template.mean();area=frame[y0-r:y1+r,x0-r:x1+r].mean(axis=2);ones=np.ones(template.shape)
   sums=fftconvolve(area,ones,mode='valid');squares=fftconvolve(area*area,ones,mode='valid')
   score=fftconvolve(area,template[::-1,::-1],mode='valid')/np.sqrt(np.maximum(squares-sums*sums/template.size,1e-8)*np.sum(template*template))
   my,mx=np.unravel_index(score.argmax(),score.shape);scores.append(float(score[my,mx]))
   if scores[-1]<.9:raise ValueError('VFX_NATIVE_RIGID_ALIGNMENT_UNCERTAIN')
   aligned=np.array(Image.fromarray(frame).transform((w,h),Image.Transform.AFFINE,(1,0,int(mx-r),0,1,int(my-r)),resample=Image.Resampling.NEAREST)).astype(np.float32)
   alpha=mask[...,None]*min(1,i/8);candidate=np.rint(base.astype(np.float32)*(1-alpha)+aligned*alpha).astype(np.uint8)
   outside=max(outside,int(np.abs(candidate[mask==0].astype(np.int16)-base[mask==0].astype(np.int16)).max()))
   if previous is not None:changes.append(float(np.abs(candidate.astype(float)-previous).mean()))
   previous=candidate.astype(float);encoder.stdin.write(candidate.tobytes())
  encoder.stdin.close()
  if encoder.wait() or decoder.wait():raise ValueError('VFX_NATIVE_CODEC_FAILED')
 finally:
  for process in (decoder,encoder):
   if process.poll() is None:process.kill()
   process.wait()
 if outside or np.mean(changes)<=.01:raise ValueError('VFX_NATIVE_REGION_QA_FAILED')
 report=dict(inputSha256=expected,outputSha256=sha(output),width=w,height=h,frames=150,fps=25,seconds=6,unchangedPixelFraction=float((mask==0).mean()),outsideRegionMaxDifferenceBeforeEncoding=outside,meanFrameDifferenceBeforeEncoding=float(np.mean(changes)),minimumRigidAlignmentScore=min(scores),animationRegions=regions,base='First decoded native Pro frame; no resized trial plate',providerCalls=0,visualApproved=False)
 (out/'nyc-native-region-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
if __name__=='__main__':main()
