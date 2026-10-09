"""Use the unchanged v3 publisher/backend with a temporary dedicated-editor user session.
Inputs are synthetic already-rendered fixture bytes; no credentials are persisted or printed.
"""
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path('scripts/podcast-editor-v3').resolve()))
from podcast_editor.storage import publish
from podcast_editor.supabase_backend import UserSession, SupabaseBackend

def main():
    cfg = json.load(sys.stdin)
    prefix = 'episodios/prueba-v3/v1'
    fixture = Path('src/lib/podcast/editor/fixtures/editor-v3')
    marker = json.loads((fixture / prefix / 'salida/COMPLETO.json').read_text())
    session = UserSession(cfg['url'], cfg['anon'], cfg['email'], '')
    session._accept(cfg['session'])
    backend = SupabaseBackend(cfg['url'], session, bucket='podcast-editor')
    with tempfile.TemporaryDirectory(prefix='editor-live-fixture-') as temp:
        root = Path(temp)
        output = root / 'salida'
        reports = {}
        for obj in marker['objetos']:
            key = obj['key']
            if not key.startswith(prefix + '/'):
                raise ValueError('foreign fixture key')
            rel = Path(key.removeprefix(prefix + '/'))
            if '..' in rel.parts or rel.is_absolute():
                raise ValueError('invalid fixture path')
            dest = root / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(fixture / key, dest)
            if rel.parts[0] == 'estado':
                reports[rel.name] = dest
        meta = {k: marker[k] for k in ['episode_id','assembly_version','editor_version','job_key','manifest_sha256']}
        result = publish(backend, prefix, output, reports, root / 'work', meta, verify_mode='completa', log=lambda *_: None)
        print(json.dumps({'objects': len(result['objects']), 'verified': len(result['verified']), 'marker_action': result['marker_action']}))

try:
    main()
except Exception:
    print('EDITOR_PUBLISH_FAILED', file=sys.stderr)
    sys.exit(1)
