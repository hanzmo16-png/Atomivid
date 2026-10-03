"""Native-source matte preparation, not a production render or relighting claim."""
import hashlib,json,os,sys,subprocess,zipfile
from pathlib import Path
import numpy as np
import cv2
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'precampaign-teaser'))
from vfx002_matte import run_rvm,matte_stats

def main():
 root=Path(sys.argv[1]);source=root/'source.mp4';model=root/'rvm.onnx'
 alpha=run_rvm(str(model),str(source),ds=.4,size=(1080,1920))
 if alpha.shape!=(150,1920,1080):raise ValueError('VFX_MATTE_SOURCE_ALIGNMENT')
 for start in range(0,150,10):np.savez_compressed(root/f'matte-part-{start:03}.npz',alpha=alpha[start:start+10])
 for n in (25,75,125):
  subprocess.run(['ffmpeg','-v','error','-i',str(source),'-vf',f'select=eq(n\\,{n})','-frames:v','1',str(root/f'source-{n}.png')],check=True)
  cv2.imwrite(str(root/f'matte-{n}.png'),alpha[n])
  s=cv2.imread(str(root/f'source-{n}.png'))
  checker=((np.indices((1920,1080)).sum(axis=0)//32)%2)*45+100
  a=alpha[n].astype(np.float32)[...,None]/255
  cut=np.rint(s*a+checker[...,None]*(1-a)).astype(np.uint8)
  cv2.imwrite(str(root/f'cutout-{n}.png'),cut)
 report={'stage':'matte-preparation','sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'modelSha256':hashlib.sha256(model.read_bytes()).hexdigest(),'modelSource':'PeterL1n/RobustVideoMatting v1.0.0 rvm_mobilenetv3_fp32.onnx','nativeWidth':1080,'nativeHeight':1920,'frames':150,'matteParts':[{'file':f'matte-part-{start:03}.npz','startFrame':start,'endFrame':start+10,'sha256':hashlib.sha256((root/f'matte-part-{start:03}.npz').read_bytes()).hexdigest()} for start in range(0,150,10)],'matte':matte_stats(alpha),'geometricWarp':False,'motionCalls':0,'productionReady':False,'visualReviewRequired':True}
 (root/'matte-report.json').write_text(json.dumps(report,indent=2))
 with zipfile.ZipFile(root/'private-proof.zip','w',zipfile.ZIP_DEFLATED) as z:
  for p in root.iterdir():
   if p.suffix in ('.png','.json'):z.write(p,p.name)
 print(json.dumps({'frames':150,'nativeWidth':1080,'nativeHeight':1920,'productionReady':False,'visualReviewRequired':True}))

if __name__=='__main__':main()
