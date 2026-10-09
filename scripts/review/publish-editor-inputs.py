"""Prepare and publish synthetic prueba-v3/v2 inputs; LISTO.json is inserted last."""
import hashlib
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path('scripts/podcast-editor-v3').resolve()
sys.path[:0] = [str(ROOT), str(ROOT / 'tests')]
import fixtures as fx
from podcast_editor.storage import fetch_inputs
from podcast_editor.supabase_backend import UserSession, SupabaseBackend

def prepare(root):
    fx.media_set(root)
    rel = fx.premix(root, 9.5, 'wav')
    m = fx.base_manifest(root, [
        fx.meta(root, 'fondo', 'medios/fondo.png', 'image'),
        fx.meta(root, 'anim', 'medios/anim12.mp4', 'animation'),
        fx.meta(root, 'mezcla', rel, 'mezcla_final'),
    ], [
        {'id':'s1','type':'image','source':'fondo','duration':3},
        {'id':'s2','type':'animation','source':'anim','in':1,'duration':5},
        {'id':'s3','type':'image','source':'fondo','duration':1},
    ], audio={'modo':'mezcla_final','source':'mezcla','timeline':'extender_ultimo'})
    m.update(episode_id='prueba-v3', assembly_version=2)
    m['output']['metadata']['title'] = 'Synthetic clean input for Grok editor v3'
    mp = fx.write_manifest(root, m)
    fx.run_editor('validate', mp, '--archivos').check_returncode()
    return m

def publish(root, cfg):
    m = prepare(root)
    session = UserSession(cfg['url'], cfg['anon'], cfg['email'], '')
    session._accept(cfg['session'])
    be = SupabaseBackend(cfg['url'], session, bucket='podcast-editor')
    prefix = 'episodios/prueba-v3/v2/entrada/'
    paths = [f['path'] for f in m['files']] + ['montaje.json']
    # New inserts only. On retry an existing byte-identical object may be reused.
    for rel in paths:
        data = (root / rel).read_bytes()
        old = be.read_bytes(prefix + rel)
        if old is None:
            be.put_bytes_new(data, prefix + rel)
        elif old != data:
            raise ValueError('INPUT_CONFLICT')
        if be.read_bytes(prefix + rel) != data:
            raise ValueError('INPUT_READBACK_MISMATCH')
    ready = (root / 'LISTO.json').read_bytes()
    old = be.read_bytes(prefix + 'LISTO.json')
    if old is None:
        be.put_bytes_new(ready, prefix + 'LISTO.json', 'application/json')
    elif old != ready:
        raise ValueError('READY_CONFLICT')
    fetched = fetch_inputs(be, 'prueba-v3', 2, root / 'readback', log=lambda *_: None)
    fx.run_editor('validate', fetched, '--archivos').check_returncode()
    print(json.dumps({'published':True,'episode':'prueba-v3','version':2,'mediaFiles':len(m['files']),
        'objects':len(paths)+1,'readyWrittenLast':True,'nativeFetchAndValidate':True,
        'manifest_sha256':hashlib.sha256((root/'montaje.json').read_bytes()).hexdigest(),'paidCalls':0}))

if __name__ == '__main__':
    try:
        if len(sys.argv) == 3 and sys.argv[1] == '--local':
            root = Path(sys.argv[2]); root.mkdir(parents=True, exist_ok=False)
            prepare(root)
            print('SYNTHETIC_INPUT_VALIDATED')
        else:
            cfg = json.load(sys.stdin)
            with tempfile.TemporaryDirectory(prefix='grok-input-v2-') as d:
                publish(Path(d), cfg)
    except Exception as e:
        print('INPUT_PUBLICATION_FAILED:' + type(e).__name__, file=sys.stderr)
        sys.exit(1)
