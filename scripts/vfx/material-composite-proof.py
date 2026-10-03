"""Three still integration controls, never a final motion substitute or gate approval.
Uses native original pixels and measured RVM masks; proposed gain/bias fields are
separate for each world. They are a 2D lighting approximation requiring review.
"""
import hashlib,json,sys,warnings
from pathlib import Path
import numpy as np
from PIL import Image,ImageFilter,ImageDraw
from scipy.ndimage import distance_transform_edt
from sequence_pixels import composite

def main():
 controls=Path(sys.argv[1]);plates=Path(sys.argv[2]);out=Path(sys.argv[3]);out.mkdir(exist_ok=True)
 names={'nyc':'Nueva-York-frame-ley.png','beach':'Playa-frame-ley.png','moon':'Luna-frame-ley.png'}
 sources={n:np.array(Image.open(controls/f'source-{n}.png').convert('RGB')).astype(np.float32)/255 for n in (25,75,125)}
 masks={n:np.array(Image.open(controls/f'matte-{n}.png')).astype(np.float32)/255 for n in sources}
 samples=np.stack(list(sources.values()));valid=np.stack([a<.02 for a in masks.values()]);samples[~valid]=np.nan
 with warnings.catch_warnings():
  warnings.simplefilter('ignore',RuntimeWarning);room=np.nanmedian(samples,axis=0)
 missing=~np.isfinite(room).all(-1)
 if missing.all():raise ValueError('VFX_ROOM_UNOBSERVED')
 nearest=distance_transform_edt(missing,return_distances=False,return_indices=True);room[missing]=room[tuple(nearest[:,missing])]
 report={'stage':'still-material-integration-proof','width':1080,'height':1920,'motionApproved':False,'integrationApproved':False,'productionReady':False,'grainPasses':0,'geometricWarp':False,'transition':'hard cuts only; no sequence rendered','plateNormalization':'Deterministic 720-to-1080 resize for proof only; final requires native 1080 motion plate','lightingModel':'Proposed 2D gain/bias, no new geometry or physically certified cast shadows','controls':[]}
 previews=[]
 settings={'nyc':(25,[.82,.90,1.02],[0,.004,.016],1.0),'beach':(75,[.99,1.02,1.04],[.007,.007,.007],1.8),'moon':(125,[.94,.96,.99],[-.012,-.012,-.012],2.5)}
 for world,(n,rgb,bias_rgb,lens_radius) in settings.items():
  s=sources[n];a=masks[n];plate_path=plates/names[world];original_plate=plate_path.read_bytes()
  p=Image.open(plate_path).convert('RGB').resize((1080,1920),Image.Resampling.LANCZOS)
  # Provisional optical matching, never removes blur already present in the approved plate.
  p=p.filter(ImageFilter.GaussianBlur(lens_radius));p=np.array(p).astype(np.float32)/255
  gain=np.broadcast_to(np.array(rgb,np.float32),(1920,1080,3)).copy();bias=np.broadcast_to(np.array(bias_rgb,np.float32),gain.shape).copy()
  if world=='moon':gain*=np.linspace(1.09,.81,1080,dtype=np.float32)[None,:,None]
  y=composite(s,p,a,room,gain,bias);u8=np.rint(y*255).astype(np.uint8)
  ref=np.rint(np.clip(s*gain+bias,0,1)*255).astype(np.uint8);interior=a==1
  delta=int(np.abs(u8[interior].astype(np.int16)-ref[interior].astype(np.int16)).max())
  if not interior.any() or delta:raise ValueError('VFX_SUBJECT_LOCK_FAILED')
  filename={'nyc':'Prueba-Nueva-York.png','beach':'Prueba-Playa.png','moon':'Prueba-Luna.png'}[world]
  Image.fromarray(u8).save(out/filename)
  look_path=out/f'{world}-proposed-look.npz';np.savez_compressed(look_path,gain=gain,bias=bias,room=room)
  report['controls'].append({'environmentId':world,'sourceFrame':n,'sourceFrameSha256':hashlib.sha256((controls/f'source-{n}.png').read_bytes()).hexdigest(),'matteSha256':hashlib.sha256((controls/f'matte-{n}.png').read_bytes()).hexdigest(),'plateSha256':hashlib.sha256(original_plate).hexdigest(),'proposedLookSha256':hashlib.sha256(look_path.read_bytes()).hexdigest(),'subjectInteriorPixels':int(interior.sum()),'subjectMaxDifferenceVsFrozenGrade':delta,'addedLensBlurRadius':lens_radius,'outputSha256':hashlib.sha256((out/filename).read_bytes()).hexdigest(),'approval':'REQUIRED'})
  thumbnail=Image.fromarray(u8).resize((360,640),Image.Resampling.LANCZOS);previews.append((world,thumbnail))
 sheet=Image.new('RGB',(1080,680),(15,15,15));draw=ImageDraw.Draw(sheet)
 for i,(world,thumbnail) in enumerate(previews):sheet.paste(thumbnail,(360*i,40));draw.text((360*i+12,12),{'nyc':'NUEVA YORK','beach':'PLAYA','moon':'LUNA'}[world],fill='white')
 sheet.save(out/'Prueba-tres-entornos.png');(out/'proof-report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))

if __name__=='__main__':main()
