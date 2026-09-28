-- Delivery / Storage foundation: one row per delivered object (master, preview, HLS,
-- intermediate, manifest) with checksum, size, duration and retention. Stores storage
-- PATHS only: signed URLs are credentials, generated on demand, never persisted.
-- Service-role only (RLS on, no client policies). Nothing is deleted by this migration.

create table if not exists public.delivery_assets (
  id bigint generated always as identity primary key,
  project_id text not null,
  asset_type text not null check (asset_type in ('MASTER','PREVIEW','HLS','INTERMEDIATE','MANIFEST')),
  storage_bucket text not null default 'videos',
  storage_path text not null check (storage_path !~ '[?&]token=' and storage_path !~* '^https?://'),
  checksum_sha256 text not null check (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint not null check (size_bytes > 0),
  duration_seconds numeric check (duration_seconds is null or duration_seconds > 0),
  content_type text not null,
  progressive boolean,
  retention_policy text not null check (retention_policy in ('keep','days')),
  retention_days int check ((retention_policy = 'keep') = (retention_days is null)),
  created_at timestamptz not null default now(),
  unique (project_id, asset_type, storage_path),
  -- Masters and manifests are never auto-expired.
  constraint delivery_assets_masters_kept check (asset_type not in ('MASTER','MANIFEST') or retention_policy = 'keep')
);
create index if not exists delivery_assets_project_idx on public.delivery_assets (project_id, asset_type);

alter table public.delivery_assets enable row level security;
