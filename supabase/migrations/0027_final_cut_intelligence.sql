-- Final Cut Intelligence V1: auditable editorial inspections, issues, repairs (proposed and
-- executed, with before/after master ids), QA decisions with human overrides, and the
-- per-master metrics row that a later learning loop may join with yt_video_links.project_id.
-- Append-only by trigger; service-role only (RLS on, no client policies). Nothing dropped.

create table if not exists public.fc_inspections (
  report_id text primary key,
  master_id text not null,
  production_id text not null,
  inspection_version text not null,
  policy_version text not null,
  mode text not null check (mode in ('INSPECT_ONLY','REPAIR')),
  source_kind text not null check (source_kind in ('media','edit_timeline','media+edit_timeline')),
  source_ref text not null,
  input_sha256 text not null check (input_sha256 ~ '^[a-f0-9]{64}$'),
  verdict text not null check (verdict in ('PASS','REPAIR_REQUIRED','FAIL','HUMAN_REVIEW_REQUIRED')),
  technical jsonb not null,
  editorial jsonb not null,
  opening jsonb not null,
  counts jsonb not null,
  reasons text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists fc_inspections_master_idx on public.fc_inspections (master_id, created_at);

create table if not exists public.fc_issues (
  report_id text not null references public.fc_inspections (report_id) on delete cascade,
  issue_id text not null,
  category text not null check (category in ('visual','rhythm','audio','subtitles','opening','technical')),
  rule text not null,
  severity text not null check (severity in ('info','minor','major','blocking')),
  confidence double precision not null check (confidence >= 0 and confidence <= 1),
  start_time double precision,
  end_time double precision,
  shot_id text,
  description text not null,
  evidence jsonb not null default '{}',
  recommended_action text not null,
  repair_class text not null check (repair_class in ('AUTO_FIX','SMART_REPAIR','ESCALATE','NONE')),
  primary key (report_id, issue_id)
);

create table if not exists public.fc_repairs (
  repair_id text primary key,
  master_id text not null,
  issue_id text,
  rule text not null,
  kind text not null check (kind in ('AUTO_FIX','SMART_REPAIR')),
  proposed_repair text not null,
  method text,
  provider_required text,
  estimated_usd numeric not null default 0 check (estimated_usd >= 0),
  worst_case_usd numeric not null default 0 check (worst_case_usd >= 0),
  expected_improvement text,
  fallback text,
  provenance_impact text,
  gates jsonb not null default '{}',
  status text not null check (status in ('PROPOSED','GATED_OK','GATED_BLOCKED','AUTHORIZED','EXECUTED','REJECTED')),
  authorized_by text,
  reservation_id text,
  before_master_id text,
  after_master_id text,
  operations jsonb,
  render_ref text,
  executed_at timestamptz,
  created_at timestamptz not null default now(),
  -- A SMART_REPAIR can only be EXECUTED with a named person and a reservation.
  constraint fc_repairs_paid_execution_authorized check (kind = 'AUTO_FIX' or status <> 'EXECUTED' or (authorized_by is not null and reservation_id is not null))
);

create table if not exists public.fc_qa_decisions (
  id bigint generated always as identity primary key,
  production_id text not null,
  master_id text not null,
  from_state text not null,
  to_state text not null check (to_state in ('EDITORIAL_PENDING','EDITORIAL_INSPECTING','EDITORIAL_REPAIR_REQUIRED','EDITORIAL_REPAIRING','EDITORIAL_REINSPECTION','EDITORIAL_QA_PASS','EDITORIAL_QA_FAIL','HUMAN_REVIEW_REQUIRED')),
  report_id text,
  evidence text[] not null default '{}',
  human_override jsonb,
  decided_at timestamptz not null,
  -- Leaving human review always records who decided.
  constraint fc_qa_human_override_recorded check (from_state <> 'HUMAN_REVIEW_REQUIRED' or human_override is not null)
);
create index if not exists fc_qa_decisions_master_idx on public.fc_qa_decisions (master_id, decided_at);

-- Learning loop (data only, no automation): editorial metrics of the master that passed,
-- joinable with yt_video_links (project_id) and yt_metric_rows later by a HUMAN analysis.
create table if not exists public.fc_master_metrics (
  production_id text not null,
  master_id text not null,
  report_id text not null references public.fc_inspections (report_id),
  metrics jsonb not null,
  recorded_at timestamptz not null default now(),
  primary key (production_id, master_id)
);

create or replace function public.fc_append_only() returns trigger language plpgsql as $$
begin raise exception 'final cut records are append-only (%)', tg_table_name; end $$;
drop trigger if exists fc_inspections_append_only on public.fc_inspections;
create trigger fc_inspections_append_only before update or delete on public.fc_inspections for each row execute function public.fc_append_only();
drop trigger if exists fc_issues_append_only on public.fc_issues;
create trigger fc_issues_append_only before update or delete on public.fc_issues for each row execute function public.fc_append_only();
drop trigger if exists fc_qa_decisions_append_only on public.fc_qa_decisions;
create trigger fc_qa_decisions_append_only before update or delete on public.fc_qa_decisions for each row execute function public.fc_append_only();

alter table public.fc_inspections enable row level security;
alter table public.fc_issues enable row level security;
alter table public.fc_repairs enable row level security;
alter table public.fc_qa_decisions enable row level security;
alter table public.fc_master_metrics enable row level security;
