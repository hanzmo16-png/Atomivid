# Migration history reconciliation (2026-09-29). Nothing was applied to production.

## What was reconciled
The V1 audit found production ahead of the repo lineage: 0020 + 0021 were applied on 2026-09-26 from `claude/voices-medieval-tts` (workflow run 36267136646), and 0022 on 2026-09-27 from `claude/tts-podcast` (run 36286808790). Neither branch is merged.

- **Restored byte-for-byte.** `0020_audiovisual_direction.sql`, `0021_voices_and_text_to_speech.sql` and `0022_tts_podcast.sql` were copied from `origin/claude/tts-podcast@9dd5760`. 0020 and 0021 are identical to `origin/claude/voices-medieval-tts@1a0272d`.
- **No divergent variants.** Every remote branch was scanned:
  - 0020 is on 12 branches, 0021 on 9 and 0022 on 6, each with exactly one hash;
  - no other file numbered 0020–0029 exists on any branch;
  - 0023–0025 exist only on this branch.
- **Manifest.** `supabase/migration-manifest.json` (manifestVersion 1) lists every file with `migrationName`, `sha256`, `sourceBranch`, `knownProductionApplied`, `appliedDate` and evidence.
  - 0001–0019 are byte-identical to the default branch `claude/atomivid-mvp-setup-0079jv`. Their production dates are UNKNOWN, because the database is not readable from here.
  - 0023–0025 are `knownProductionApplied: false`.

| file | sha256 (first 16) | source | production |
|---|---|---|---|
| 0020_audiovisual_direction | f37629536676f784 | claude/voices-medieval-tts | applied 2026-09-26 |
| 0021_voices_and_text_to_speech | d0ad18ece3453faf | claude/voices-medieval-tts | applied 2026-09-26 |
| 0022_tts_podcast | be03eec66f3085d8 | claude/tts-podcast | applied 2026-09-27 |
| 0023_production_intelligence | see manifest | this branch | NOT applied |
| 0024_distribution_youtube | see manifest | this branch | NOT applied |
| 0025_delivery_assets | see manifest | this branch | NOT applied |

## Local verification (Postgres 16, Supabase stub schema)
| check | result |
|---|---|
| Clean apply of 0001→0025 on a fresh database | 25/25 OK |
| Raw SQL re-run | 0023–0025 are re-runnable. 0001, 0003, 0007, 0008, 0021 and 0022 fail on re-run ("policy … already exists", "constraint … already exists"); these are pre-existing, and in production idempotency comes from the registry. |
| Real `scripts/apply-supabase-migration.ts` run against a local database that mirrors production (0001–0022 applied and registered). `SUPABASE_DB_URL` pointed only at the local socket. | Run 1 applied exactly 0023, 0024 and 0025 and skipped 22. Run 2 applied 0 and skipped 25. |
| RLS + UNIQUE idempotency (`01_rls_and_idempotency_test.sql`) | PASS |
| PI / distribution / delivery checks (`03_production_intelligence_test.sql`) | ALL PASSED (fresh database and rehearsal database) |
| Destructive statements in 0023–0025 | None. The apply script's detector passes them. Every `drop trigger if exists` and `alter table` targets tables created in the same file. |
| Legacy worker behavior | Unchanged. 0023–0025 only create new `pi_*`, `yt_*` and `delivery_assets` tables; no worker, video or script code references them. |

## Future checksum design (documented only; the production table is not modified)
1. **Add a checksum column.** A future expand-only migration adds `checksum_sha256 text null` to `public._migrations_applied`, and enables RLS on it with no client policy. This also fixes the pre-existing finding that the table has no RLS.
2. **Store and compare checksums.** The apply script writes `sha256(file bytes)` next to `name` on insert. On every run, for each registered name:
   - stored checksum ≠ file → stop (new exit code) for human review;
   - stored checksum NULL → report it as `legacy-unverified`, and never apply it again.
3. **Backfill.** Existing rows get their checksum from `migration-manifest.json`, and only after a human-confirmed read-only connection shows that the registry names match the manifest exactly.
4. **Manifest as authority.** The manifest becomes the authority that CI checks: any `.sql` file whose hash differs from its manifest entry fails CI.

## Recommendation for 0023–0025: **SAFE_TO_APPLY** (not applied)
- **What changed since the V1 audit:** the lineage is reconciled, content is verified by hash, the real apply procedure was rehearsed against the known production registry state, and the migrations are expand-only, RLS-covered and idempotent.
- **Preconditions (apply still needs explicit human authorization):**
  1. A human-confirmed read of `public._migrations_applied` shows exactly 0001–0022.
  2. Apply from a branch that contains this manifest.
- **Residual risk:** until the checksum design ships, production content of 0001–0022 can only be matched by name, not by content.
- **Not needed yet:** PI is not connected to the worker, so applying these migrations is not required for the next mission.
