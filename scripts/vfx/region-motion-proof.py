"""Local feasibility proof only; never registers approval, invokes providers or creates a final.
Preserve exact approved background outside explicitly declared animation regions.
Usage: region-motion-proof.py world approved.png recorded.mp4 output-directory
"""
import hashlib,json,pathlib,subprocess,sys
import numpy as np
from PIL import Image
from scipy.signal import fftconvolve

EXPECTED={
 'nyc':('e8c3d0aa4033b9cb116cd952aede6f094fd08f23e2b47c93bc2d733932a65f23','22c4f965c103039b350bdf45f3d8ab8206a37731a46bb42067adc88264db46fa'),
 'moon':('f0e4568511b7108381e39bb3e2d2611ab37fde36c6d087b194055553bb113d7c','70b1b50d47d757fa68050707d04fdb3e5210264227420e98e4edf2bd3c0eace0')}
REGIONS={'nyc':[(147,15,281,103),(180,290,263,374),(180,408,265,530)],'moon':[(535,510,695,642)]}
def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def main():
 world,plate,recorded,destination=sys.argv[1:];out=pathlib.Path(destination);out.mkdir(parents=True,exist_ok=True)
 if (sha(plate),sha(recorded))!=EXPECTED[world]:raise ValueError('VFX_FROZEN_INPUT_CHANGED')
 base=np.array(Image.open(plate).convert('RGB'));h,w,_=base.shape
 if (w,h)!=(720,1280):raise ValueError('VFX_PROOF_RASTER_CHANGED')
 mask=np.zeros((h,w),np.float32)
 for x0,y0,x1,y1 in REGIONS[world]:
  yy,xx=np.mgrid[y0:y1,x0:x1];edge=np.minimum.reduce([xx-x0,x1-1-xx,yy-y0,y1-1-yy]);mask[y0:y1,x0:x1]=np.maximum(mask[y0:y1,x0:x1],np.clip(edge/8,0,1))
 decoder=subprocess.Popen(['ffmpeg','-v','error','-i',recorded,'-frames:v','150','-pix_fmt','rgb24','-f','rawvideo','-'],stdout=subprocess.PIPE)
 path=out/(world+'-region-proof.mp4')
 encoder=subprocess.Popen(['ffmpeg','-v','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s','720x1280','-r','25','-i','-','-frames:v','150','-an','-c:v','libx264','-crf','18','-preset','fast','-pix_fmt','yuv420p',str(path)],stdin=subprocess.PIPE)
 first=None;offsets=[];outside=0;changes=[];previous=None
 try:
  for i in range(150):
   raw=decoder.stdout.read(w*h*3)
   if len(raw)!=w*h*3:raise ValueError('VFX_PROOF_SHORT_INPUT')
   frame=np.frombuffer(raw,np.uint8).reshape(h,w,3)
   if first is None:first=frame.copy()
   dx=dy=0
   if world=='nyc':
    # Match rigid facade, excluding every animated sign. This is translation only,
    # and cannot certify perspective/terrain deformation correction.
    x0,y0,x1,y1=540,60,680,350;r=28
    gray=frame.mean(axis=2);template=first[y0:y1,x0:x1].mean(axis=2);template-=template.mean()
    area=gray[y0-r:y1+r,x0-r:x1+r];ones=np.ones(template.shape)
    numerator=fftconvolve(area,template[::-1,::-1],mode='valid')
    sums=fftconvolve(area,ones,mode='valid');squares=fftconvolve(area*area,ones,mode='valid')
    score=numerator/np.sqrt(np.maximum(squares-sums*sums/template.size,1e-8)*np.sum(template*template))
    my,mx=np.unravel_index(score.argmax(),score.shape);dx,dy=int(mx-r),int(my-r)
    if score[my,mx]<.9:raise ValueError('VFX_RIGID_ALIGNMENT_UNCERTAIN')
   # Only sign/rover regions sample recorded motion. Outside is the immutable plate.
   stabilized=np.array(Image.fromarray(frame).transform((w,h),Image.Transform.AFFINE,(1,0,dx,0,1,dy),resample=Image.Resampling.NEAREST)).astype(np.float32)
   if world=='nyc':
    # Replace screen interiors rather than add differences: addition ghosts static text.
    # The short change is local to screen content, never between world lights.
    alpha=mask[...,None]*min(1,i/8)
    candidate=np.rint(np.clip(base.astype(np.float32)*(1-alpha)+stabilized*alpha,0,255)).astype(np.uint8)
   else:
    delta=stabilized-first.astype(np.float32)
    candidate=np.rint(np.clip(base.astype(np.float32)+delta*mask[...,None],0,255)).astype(np.uint8)
   outside=max(outside,int(np.abs(candidate[mask==0].astype(np.int16)-base[mask==0].astype(np.int16)).max()))
   if i==0 and not np.array_equal(candidate,base):raise ValueError('VFX_PROOF_FIRST_FRAME_CHANGED')
   if previous is not None:changes.append(float(np.abs(candidate.astype(float)-previous).mean()))
   previous=candidate.astype(float);offsets.append([dx,dy]);encoder.stdin.write(candidate.tobytes())
  encoder.stdin.close()
  if encoder.wait() or decoder.wait():raise ValueError('VFX_PROOF_CODEC_FAILED')
 finally:
  for process in (decoder,encoder):
   if process.poll() is None:process.kill()
   process.wait()
 report=dict(world=world,stage='local-region-motion-feasibility',frames=150,fps=25,seconds=6,width=w,height=h,plateSha256=sha(plate),recordedSha256=sha(recorded),outputSha256=sha(path),animationRegions=REGIONS[world],unchangedPixelFraction=float((mask==0).mean()),outsideRegionMaxDifferenceBeforeEncoding=outside,meanFrameDifferenceBeforeEncoding=float(np.mean(changes)),alignmentOffsets=offsets,grainPasses=0,providerCalls=0,additionalUsd=0,motionApproved=False,productionReady=False,localReview='REJECTED_GHOSTED_ROVER' if world=='moon' else 'PENDING_SCREEN_CONTENT_REVIEW',limitations=['720p feasibility only; final requires native 1080 material','Encoded preview is lossy; immutability check runs before encoding','Local sign/rover region geometry, shadow/contact and region seam need visual review','Existing rejected motion reviews remain intact'])
 (out/(world+'-region-proof.json')).write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps({k:v for k,v in report.items() if k!='alignmentOffsets'}))
if __name__=='__main__':main()
