# Private channel media archive — first operational version

Status: implementation and local tests ready; see the private operator report for activation status.
This is an operator CLI for Hans's own channel. It is not a customer gallery, automatic
asset recommender, tenant authorization system, or a new dependency of the video pipeline.
Subscription changes are managed separately from these scripts. Keep account-specific
activation reports, inventory totals and billing information outside this public repository.

## What it does

- Copies supported image/video/audio/subtitle files from explicitly selected project prefixes
  into a dedicated **private** Supabase bucket. It never moves or deletes source objects.
- Uses content checksums so identical content within one owner namespace shares a copy.
  Source versions have immutable catalog entries; different bytes retain different versions.
- Verifies uploaded bytes before writing the catalog. No upsert or automatic provider retry.
- Catalogs source reference, description, tags, MIME, byte size, timestamp and checksum.
  Search is literal keyword search, not semantic AI. Every entry starts `needs_review`.
- Retrieves a selected original with checksum validation, even if the source project later
  loses its original. Retrieval never triggers paid generation.
- Exports catalog and originals for an independent backup. An export in ephemeral CI is
  not an independent backup. Keep it on a durable separately managed destination.

## Scope and limitations

The existing production caches already preserve voices, images and clips per request;
this separate archive makes selected content discoverable across projects. It does not
modify cache identities or promise that all past media still exists.

Run one operator at a time, after a production finishes. Pause source writes during a
snapshot. Concurrent writes can produce an explicit conflict; rerun once reviewed. A partial
failure leaves verified blobs for the next run and never deletes originals. A corrupt copy
is an error, not a reason to silently overwrite data.

This phase deliberately has no UI thumbnails, automatic duration probing, automatic
post-render trigger, license approval, usage-history tracking or scheduled backup. These
are future additions. The operator supplies accurate project tags and verifies provenance,
licenses and editorial suitability against the original production manifest before reuse.
Do not copy client or avatar material into this channel archive. The service-role key bypasses
RLS; explicit source scopes must be reviewed by the operator. No public or user-facing policy
is installed on the destination bucket.

Files larger than the configured object limit cause a stop. The example uses 50 MiB, not a
claim about the account's current limit. The bounded-buffer implementation rejects a configured
limit above 256 MiB. A later streaming implementation is needed for larger masters. Unsupported
extensions and non-media state files are excluded; preserve source manifests separately.

## Activation procedure (no paid media generation)

1. Confirm the actual organization plan, current **organization-wide** storage usage,
   transfer usage and spend cap in Supabase Billing/Usage. The storage API can inventory
   this project's current files but cannot determine subscription or billed monthly average.
2. Confirm source ownership and prefixes, including any request-ID asset directories not
   under `long-form/<video-id>/`. The example imports only the ocean prefix; it is NOT a full
   historical import or proof that all ocean files are under that prefix.
3. Copy the example to a private operator config outside the repository. Set byte budgets
   conservatively from the real available capacity and allowance. These budgets are local
   archive safeguards, not provider quotas or a billing cap. Existing project files and
   other projects also consume storage. Creating a bucket does not increase account capacity.
4. Run inventory, init, dry-run and archive as below. The SDK is already a project dependency.
   Supply `SUPABASE_URL` (or `NEXT_PUBLIC_SUPABASE_URL`) and `SUPABASE_SERVICE_ROLE_KEY`
   through the existing secure runtime. Do not put keys in config files, commands or logs.

```bash
node --test scripts/lib/private-media-library.test.mjs
node scripts/private-media-library.mjs inventory --config /private/channel-library.json
node scripts/private-media-library.mjs init --config /private/channel-library.json --apply
node scripts/private-media-library.mjs archive --config /private/channel-library.json
node scripts/private-media-library.mjs archive --config /private/channel-library.json --apply
node scripts/private-media-library.mjs search --config /private/channel-library.json --query ocean
node scripts/private-media-library.mjs get --config /private/channel-library.json --id CATALOG_ID --out /private/selected-clip.mp4
node scripts/private-media-library.mjs backup --config /private/channel-library.json --out /durable-independent-backup/channel-library
```

`archive` without `--apply` performs listings only. Dry-run requires the destination bucket
to exist. Initialization only creates a missing private bucket; it will never convert an
existing public bucket. List, download and permission failures stop the operation. A missing
bucket is distinguished from denied access. Archives and backups transfer bytes and may
incur storage/egress charges despite making no paid generation calls.

The archive plan reserves all selected source bytes plus 16 KiB per catalog record, even
where duplicates may reduce actual growth. This intentionally errs on the side of stopping
early. Run smaller scopes rather than disabling safeguards. Large old libraries must be
partitioned or moved to a streaming/indexed implementation after this first phase.

5. Verify the archived sample by hash and playback; search and retrieve it without calling
   generators. Repeat archive and confirm no new object versions or overwritten originals.
6. Export to the approved independent destination. Verify exported checksums and open a
   sample from that destination, not from the primary project. Record last successful backup.
7. Add this manual archive/export step to the operator's production checklist for every
   completed video. Automating that checklist requires a separately reviewed integration.

## Restoration from an exported backup

An export contains a timestamped `catalog-<hash>.json` and the exact `owner/objects/...`
files referenced by its entries. Preserve the complete directory tree.
To recover a resource offline, find its entry in the catalog, verify the corresponding file's
SHA-256 against `sha256`, and use that original in a new montage. No API or old signed URL
is needed. To rebuild a Supabase archive, use a new private bucket, upload those objects
without changing paths, and reconstruct each `owner/catalog/<id>.json` from the exported
entries, updating the bucket field if the destination differs. Test a restored copy before
claiming the backup is usable. A full remote restore command is not included in this phase.

## Capacity and billing

Do not interpret Hans's approval of about US$2.13/month extra storage as automatic
authorization to upgrade from Free to Pro or to disable the organization's spend cap.
On 2026-09-27, the published Pro plan starts at US$25/month and includes 100 GB of file
storage; overage storage is US$0.0213/GB/month. Another 100 GB averaged across a month
therefore adds approximately US$2.13 for storage alone. Transfers, compute, backup destination,
taxes and the base subscription are separate. Inspect the real account before any charge.

Suggested operator review thresholds: 70% usage = review growth, 85% = arrange capacity
before the next batch, 95% = hold new generation until headroom is verified. These are
recommended thresholds, not live alerts implemented by this CLI. Provider billing averages
and this project's point-in-time object inventory are different measurements.

References:
- https://supabase.com/pricing
- https://supabase.com/docs/guides/platform/manage-your-usage/storage-size
- https://supabase.com/docs/guides/platform/backups (database backups exclude Storage bytes)

## Verification performed

Local tests cover scoped selection, source retention, checksum readback, duplicate content,
immutable source versions, rerun recovery after metadata failure, corrupt destinations,
private-bucket enforcement, byte limits before transfers, listing pagination, denied access,
missing size metadata, path traversal, owner isolation and the SDK's `upsert: false` behavior.
Record live plan, inventory, upload, retrieval and independent-backup results in the private
operator report. Distinguish each verified step from any remaining work. A successful archive
is not proof of an independent backup or automatic archival of future productions.
