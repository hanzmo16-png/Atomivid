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
  "verificacion": "completa",
  "objetos": [ { "key": "<path inside the episode/version>", "size": <bytes>, "sha256": "<64 hex>" } ] }
```

- Every declared object is verified (size, written before the marker, sha256): `salida/<file>`,
  `salida/muestras/<file>` and `estado/reporte-*.json`. Keys may be full bucket keys of this episode/version or
  relative to it; any other episode/version, `entrada/`, traversal, empty or odd segments, the marker itself or
  a duplicate (also after normalisation) rejects the whole delivery.
- `verificacion` must be `completa` or `sidecar`; the app always recomputes every declared object's sha256
  before reporting `terminado`. It does not compare `manifest_sha256` with the input manifest.

## Verified vs pending
- Verified: all 11 editor tests pass, including the mandatory integration test against output generated
  by editor v0.3.0 from synthetic media. No editor test is skipped. The real fixture and original publisher
  source were committed in `d4a9b2e`; its 17 declared objects are byte-for-byte editor output.
- Source: `scripts/podcast-editor-v3/`; fixture: `src/lib/podcast/editor/fixtures/editor-v3/episodios/prueba-v3/v1/`.
- The publisher inserts outputs and hash sidecars, downloads every declared output to verify its hash in
  `completa` mode, then writes `salida/COMPLETO.json` last. Existing outputs must match; no overwrite.
- Not verified: real Auth/Storage listing as an enrolled owner, signed URLs from the real bucket, playback in
  the browser, the 300 s hashing budget on a real multi-GB file.

## Live checks (2026-10-09, production database; no write, no provider call)
Run `37987926465` (branch `claude/video-review`, `scripts/review/podcast-editor-live.ts`), evaluated as the
`authenticated` role with request JWT claims inside a rolled-back read-only transaction:

| Check | Result |
|---|---|
| Enrolled owners | 1 |
| `es_propietario()` as that owner / an ordinary account / unknown sub | true / false / false |
| Bucket `podcast-editor` public | false |
| Objects / COMPLETO.json / assignments | 0 / 0 / 0 |

These counts describe the earlier read-only run, not the current bucket contents.
Browser validation is prepared (`scripts/review/podcast-editor-app-e2e.ts`, mode `podcast-editor-app`):
owner list → verify → `terminado` → playback → every download byte-exact with the declared sha256; ordinary
account 404; anonymous 401. It runs against the PR preview first, then production after merge.

## Real synthetic publication (2026-10-09)

Completed in [Actions run 37993513622](https://github.com/hanzmo16-png/Atomivid/actions/runs/37993513622),
commit `1aaf99f` on `claude/video-review`. The runner called the unchanged v3 publisher against real
Supabase Storage using the dedicated assigned editor's authenticated session. Administrative Auth access
was used only to obtain that temporary editor session; the Python publisher received no service role key.
The temporary session was signed out. No owner session or paid provider call was used.

- Delivery: `episodios/prueba-v3/v1/salida/COMPLETO.json`.
- All 17 declared output/report objects were downloaded and verified in `completa` mode.
- Marker object list exactly matches the committed editor-generated fixture.
- Database readback: 35 objects = 17 declared objects + 17 hash sidecars + 1 marker; bucket remains private.
- Latest data object: `2026-10-09T21:18:00.961279Z`; marker: `2026-10-09T21:28:32.674967Z`.
  Thus the marker was created after every data object and sidecar.
- A local publish attempt uploaded the data but was interrupted before completion. The runner resumed
  idempotently, comparing existing files without overwriting them, and wrote the final marker.

## Preview preparation (before browser validation)

The owner ID variable is configured for Preview specifically on `claude/podcast-editor-results`.
The public Supabase URL/key variables also target Preview. A deployment of `eab061e` with that
configuration is READY (`dpl_9qgPkFt7wm7ax2pcz6ug94fni388`); its protected `/login` route returned 200
through the Vercel authenticated fetch tool. This checks deployment availability, not owner access.

The owner subsequently authorized temporary sign-in and protected-preview access. See the completed
validation below. PR #86 remains draft and unmerged; production app routes have not been validated.


## Completed owner browser validation (2026-10-09)

[Actions run 37994993707](https://github.com/hanzmo16-png/Atomivid/actions/runs/37994993707)
passed against deployment `dpl_ED4DjXU9XrWjeSnRrWtmooqzaEdg`, app commit `40d9764`.
The test runner is commit `6049d4f` on `claude/video-review`.

| Assertion | Result |
|---|---|
| Owner opens list and sees the real delivery pending verification | PASS |
| Version page exposes the verification control | PASS |
| UI verification returns `terminado` | PASS |
| Primary MP4 actually plays in the browser | PASS |
| All 17 downloads match declared bytes and sha256, with attachment disposition | PASS |
| Signed playback links have a lifetime of at most 15 minutes | PASS |
| Dedicated non-owner account: page / verification API | 404 / 404 |
| Anonymous verification API | 401 |
| Both temporary sessions in successful run logged out | PASS / PASS |

Ten functional assertions passed, plus two logout checks. No paid provider calls.
The initial failures were in the harness: the app's first-visit guide intercepted the verification click.
The runner now dismisses the guide using its normal Omitir button. It also handles the response/click
promises together so a failed click cannot abort logout through an unhandled rejection.

### Cleanup follow-up

The deployment-scoped, one-hour share token was revoked successfully after testing. Its GitHub secret
therefore grants no access. Removing that now-inert secret is awaiting GitHub's account re-verification.
The first failed run (`37994231374`) exited before logout and left one temporary owner session record.
An aggregate database check confirmed one matching session remained. Automatic approval review blocked
inspection of session identifiers and direct session expiry, so neither operation was performed.
The second run and the final successful run both completed their normal targeted logout. Selective cleanup
of the first run's session still needs explicit approval; do not log out unrelated owner sessions.
