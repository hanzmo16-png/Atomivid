"""Insert the four approved avatar cuts without moving the episode's audio timeline."""
import copy, hashlib, json, sys
from pathlib import Path

root=Path(sys.argv[1]); original=json.loads((root/'v3.json').read_text()); avatar=json.loads((root/'avatar-result.json').read_text())
manifest=copy.deepcopy(original); fps=int(manifest['output']['fps']); total=round(manifest['expected_total_seconds']*fps)
cuts=copy.deepcopy(avatar['cuts']); cuts[-1]['globalEnd']=total/fps
pieces=[]; cursor=0
for shot in original['timeline']:
    start=cursor; end=start+round(shot['duration']*fps); cursor=end
    windows=[(start,end)]
    for cut in cuts:
        a,z=round(cut['globalStart']*fps),round(cut['globalEnd']*fps)
        windows=[p for x,y in windows for p in ([(x,y)] if z<=x or a>=y else [(x,min(a,y)),(max(z,x),y)]) if p[1]>p[0]]
    for n,(a,z) in enumerate(windows):
        out=copy.deepcopy(shot)
        if (a,z)!=(start,end):
            out['id']=shot['id']+'_recut_'+str(n);out['duration']=(z-a)/fps
            if shot['type'] in ('broll','animation','avatar'):
                speed=((shot['out']-shot.get('in',0))/shot['duration']) if shot.get('insuficiente',{}).get('modo')=='ajustar_velocidad' else 1
                out['in']=shot.get('in',0)+(a-start)/fps*speed
                out['out']=out['in']+(z-a)/fps*speed
        pieces.append((a,z,out))
for cut in cuts:
    a,z=round(cut['globalStart']*fps),round(cut['globalEnd']*fps)
    pieces.append((a,z,{'id':'avatar_'+cut['id'],'type':'avatar','source':'asset_31','duration':(z-a)/fps,
        'fit':'contain','use_audio':False,'label':'Hans · Avatar de IA','in':round(cut['batchStart']*fps)/fps,
        'out':round(cut['batchStart']*fps)/fps+(z-a)/fps,'fit_mode':'trim'}))
pieces.sort(key=lambda p:p[0]); clean=[]
for a,z,shot in pieces:
    # Avoid a six-frame stock insert immediately before the final address.
    if z-a<fps/2 and clean and clean[-1][2]['type']=='image' and clean[-1][1]==a:
        x,_,prev=clean[-1];prev['duration']=(z-x)/fps;clean[-1]=(x,z,prev)
    else:clean.append((a,z,shot))
assert clean[0][0]==0 and clean[-1][1]==total
assert all(left[1]==right[0] for left,right in zip(clean,clean[1:]))
assert sum(round(p[2]['duration']*fps) for p in clean)==total
assert sum(p[2]['type']=='avatar' for p in clean)==4
manifest['assembly_version']=4;manifest['timeline']=[p[2] for p in clean]
p=root/'entrada/medios/31-avatar-Hans-1080p.mp4'
manifest['files'].append({'id':'asset_31','path':'medios/'+p.name,'size':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'role':'avatar'})
assert manifest['audio']==original['audio'] and manifest['subtitles']==original['subtitles'] and manifest['chapters']==original['chapters']
assert manifest['files'][:-1]==original['files']
manifest['_estado_editorial']='Edición final con cuatro intervenciones del avatar de Hans. Narración y mezcla de v3 preservadas.'
for source in manifest.get('sources_credits',{}).get('sources',[]):
    if not isinstance(source.get('text'),str):continue
    text=source['text']
    text=text.replace('Montaje narrado para revisión — 9 de octubre de 2026','Edición final v4 — 9 de octubre de 2026')
    text=text.replace('Las intervenciones nuevas del avatar quedan pendientes: el control de gasto diario de HeyGen rechazó su disponibilidad. No se generó ni cobró avatar nuevo para este episodio.',f"Cuatro intervenciones nuevas del avatar de Hans integradas, con su voz ya grabada y el estudio espacial aprobado. HeyGen: USD {avatar['costUsd']:.2f} registrados para esta generación.")
    text=text.replace('Total del ledger de estas dos etapas: USD 6.4424. HeyGen nuevo: USD 0.',f"Voz y animaciones: USD 6.4424. Avatar HeyGen nuevo: USD {avatar['costUsd']:.2f}. Total de estas etapas: USD {6.4424+avatar['costUsd']:.4f}.")
    source['text']=text
data=(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode();(root/'entrada/montaje.json').write_bytes(data)
ready={'episode_id':manifest['episode_id'],'assembly_version':4,'manifest_sha256':hashlib.sha256(data).hexdigest(),'file_count':len(manifest['files'])}
(root/'entrada/LISTO.json').write_text(json.dumps(ready,indent=2)+'\n')
print(json.dumps({'segments':len(clean),'avatarSegments':4,'seconds':total/fps,'originalMediaUnchanged':31,'audioUnchanged':True}))
