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

## Assumed COMPLETO.json contract — to confirm with the editor
The editor's schema was not available in the repository or PR #85. The app expects, in
`episodios/<episode>/v<n>/salida/COMPLETO.json`:

```json
{ "episode_id": "<same as path>", "version": <same as path>,
  "salidas": [ { "archivo": "<file in salida/>", "bytes": <int>, "sha256": "<64 lowercase hex>" } ] }
```

Field names live only in `src/lib/podcast/editor/contract.ts`; parsing fails closed (an unrecognised file
never makes an episode `terminado`).

## Verified vs pending
- Verified: 9 unit tests with an in-memory Storage and real sha256 (happy path, tampered content with the same
  size, missing/oversized outputs, outputs written after the marker, wrong episode/version, path traversal,
  duplicates, longer stream than declared, timeout, owner-session-only code).
- Not verified: real Auth/Storage listing as an enrolled owner, signed URLs from the real bucket, playback in
  the browser, the 300 s hashing budget on a real multi-GB file, and the editor's real COMPLETO.json.
