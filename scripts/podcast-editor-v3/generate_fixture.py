#!/usr/bin/env python3
"""Generate a REAL editor-v3 delivery with synthetic media, via the local backend.

Usage: python3 scripts/podcast-editor-v3/generate_fixture.py /tmp/editor-v3-new-run
The destination must be new. Copy its bucket/episodios tree to the app fixture
only when deliberately replacing the integration fixture. No network or credentials.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "tests"))
import fixtures as fx

base = Path(sys.argv[1]).resolve()
base.mkdir(parents=True, exist_ok=False)
src = base / "synthetic-input"
fx.media_set(src)
rel = fx.premix(src, 9.5, "wav")
manifest = fx.base_manifest(src, [
    fx.meta(src, "fondo", "medios/fondo.png", "image"),
    fx.meta(src, "anim", "medios/anim12.mp4", "animation"),
    fx.meta(src, "mezcla", rel, "mezcla_final"),
], [
    {"id": "s1", "type": "image", "source": "fondo", "duration": 3},
    {"id": "s2", "type": "animation", "source": "anim", "in": 1, "duration": 5},
    {"id": "s3", "type": "image", "source": "fondo", "duration": 1},
], audio={"modo": "mezcla_final", "source": "mezcla", "timeline": "extender_ultimo"})
manifest["episode_id"] = "prueba-v3"
manifest["output"]["metadata"]["title"] = "Synthetic editor v3 integration fixture"
mp = fx.write_manifest(src, manifest)
for args in [
    ("validate", mp, "--archivos"),
    ("run", mp, "--work", base / "render-work"),
    ("publish", mp, "--backend", "local", "--root", base / "bucket", "--work", base / "render-work"),
]:
    result = fx.run_editor(*args)
    print(result.stdout, end="")
    print(result.stderr, end="", file=sys.stderr)
    result.check_returncode()
print(f"Delivery: {base / 'bucket/episodios/prueba-v3/v1'}")
