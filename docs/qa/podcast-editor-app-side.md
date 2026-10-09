# Podcast editor — app side (results, owner association, private playback/download)

Depends on the storage applied in migration `20261009185427` (PR #85). This change adds **no SQL** and
does not touch limits, buckets, policies or media.

## What the app does
- `/dashboard/podcast/editor` lists `episodios/<episode>/v<n>/` folders visible to the signed-in owner and
  shows each version's delivery state. Reached from `/dashboard/podcast`.
- `/dashboard/podcast/editor/<episode>/v<n>` shows the declared outputs and a "Verificar integridad y abrir"
  button (`POST /api/podcast-editor/<episode>/v<n>/verify`).
- States: `sin_entrega` (no COMPLETO.json) → `pendiente_verificar` (COMPLETO.json valid, every declared output
  exists with the declared size and was written before the marker) → `terminado` (every output's sha256
  recomputed from Storage matches). `entrega_invalida` for anything else. Only `terminado` returns playback
  and download links (signed, 15 minutes, per object, never logged). Nothing is persisted.

## Owner association
Storage is read with the **owner's own session** (cookies), never the service role. The approved policy
`pe_v2_propietario_leer` (`podcast_editor.es_propietario()`) is what grants the read, so the association
"episode → correct owner" is enforced by the database. The app adds its own gate (`canAccessLongFormBeta`,
i.e. Hans's private accounts) and answers 404 to anyone else.

## COMPLETO.json — editor v3 format
Adapted to the format published by editor v3 (reported by Codex from `editor.py` lines 1342–1345 and
`podcast_editor/storage.py` → `publish`). Read from `episodios/<episode>/v<n>/salida/COMPLETO.json`:

```json
{ "episode_id": "<same as path>", "assembly_version": <same as path>, "estado": "completo",
  "editor_version": "…", "job_key": "…", "manifest_sha256": "<64 hex>", "publicado_en": "<ISO date>",
  "verificacion": { … },
  "objetos": [ { "key": "<path inside the episode/version>", "size": <bytes>, "sha256": "<64 hex>" } ] }
```

- Every declared object is verified (size, written before the marker, sha256): `salida/<file>`,
  `salida/muestras/<file>` and `estado/reporte-*.json`. Keys may be full bucket keys of this episode/version or
  relative to it; any other episode/version, `entrada/`, traversal, empty or odd segments, the marker itself or
  a duplicate (also after normalisation) rejects the whole delivery.
- Not checked by the app: `manifest_sha256` against the input manifest and the content of `verificacion`
  (required present; their semantics belong to the editor).

## Verified vs pending
- Verified: 10 tests with an in-memory Storage and real sha256, using deliveries built in the v3 shape as
  described (not editor-generated).
- Integration test `editor v3 generated delivery verifies end to end` is in place but SKIPPED until an
  editor-generated version folder (synthetic media, with its COMPLETO.json) is committed under
  `src/lib/podcast/editor/fixtures/editor-v3/episodios/<ep>/v<n>/…`. The editor package was not available to
  this session.
- Not verified: real Auth/Storage listing as an enrolled owner, signed URLs from the real bucket, playback in
  the browser, the 300 s hashing budget on a real multi-GB file.
