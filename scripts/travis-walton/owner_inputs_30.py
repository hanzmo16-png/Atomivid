"""Prepare/fetch and publish INPUTS only, using an authorized owner JWT."""
import argparse,json,os,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'podcast-editor-v3'))
import editor
from podcast_editor import storage
from podcast_editor.supabase_backend import UserSession,SupabaseBackend,_jwt_claims

mode,rootarg=sys.argv[1:3];root=Path(rootarg);credential=root/'owner-session.json';cfg=json.loads(credential.read_text())
class OwnerSession(UserSession):
    def login(self):raise RuntimeError('Owner password login is disabled')
session=OwnerSession(cfg['url'],cfg['apikey'],'','');session._accept(cfg['session'])
assert _jwt_claims(session._access).get('sub')==cfg['ownerId']
assert _jwt_claims(session._access).get('role')=='authenticated'
be=SupabaseBackend(cfg['url'],session,state_dir=root/'transfers')
editor._backend=lambda *a,**k:be
try:
    if mode=='fetch':
        code=editor.cmd_fetch(argparse.Namespace(episode=cfg['episodeId'],version=4,dest=str(root/'source-v4'),esperar=0,intervalo=10,backend='supabase'))
    elif mode=='inputs':
        base=root/'entrada';manifest=base/'montaje.json';plan=editor.Plan(manifest)
        assert not plan.errors and plan.episode_id==cfg['episodeId'] and plan.version==5
        assert abs(plan.total-1800)<.001
        prefix=f'episodios/{plan.episode_id}/v5/entrada'
        objects=[(base/f['path'],prefix+'/'+f['path']) for f in plan.files.values()]+[(manifest,prefix+'/montaje.json')]
        for local,key in objects:
            obj=storage.put_object(be,local,key,root/'transfer-temp',lambda *_:None)
            storage.verify_object(be,key,obj['size'],obj['sha256'],root/'transfer-temp','completa')
        ready=(base/'LISTO.json').read_bytes();key=prefix+'/LISTO.json';old=be.read_bytes(key)
        if old is not None and old!=ready:raise RuntimeError('Existing input marker differs')
        if old is None:be.put_bytes_new(ready,key,'application/json')
        assert be.read_bytes(key)==ready
        print(json.dumps({'inputs':len(objects)+1,'allHashesVerified':True,'readyWrittenLast':True,'seconds':plan.total}));code=0
    else:raise RuntimeError('Only fetch and input publication are allowed')
finally:
    cfg['session']={'access_token':session._access,'refresh_token':session._refresh,'expires_at':session.expires_at}
    credential.write_text(json.dumps(cfg));os.chmod(credential,0o600)
sys.exit(code)
