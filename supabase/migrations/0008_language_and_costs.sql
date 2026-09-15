-- Atomivid — selección de idioma + instrumentación de costo por solicitud.

-- Idioma elegido por el usuario en /dashboard/new. Antes el guion detectaba
-- el idioma a partir del texto del tema (implícito, no confiable si el
-- usuario escribe el tema en un idioma pero quiere narración en otro).
alter table public.video_requests
  add column if not exists language text not null default 'es'
  check (language in ('es', 'en'));

-- Registro de uso/costo estimado por solicitud (una fila por video). No
-- reconcilia con la factura exacta del proveedor — estima a partir de lo
-- que el pipeline ya mide (caracteres, duración, tiempo de render) usando
-- las tarifas configurables de src/lib/billing/pricing.ts. Ver
-- src/lib/billing/usage.ts para cómo se escribe.
create table if not exists public.generation_costs (
  request_id uuid primary key references public.video_requests (id) on delete cascade,
  script_calls integer not null default 0,
  script_estimated_input_tokens integer not null default 0,
  script_estimated_output_tokens integer not null default 0,
  voice_provider text,
  voice_characters integer not null default 0,
  footage_provider text,
  footage_count integer not null default 0,
  music_provider text,
  video_duration_seconds numeric,
  render_ms bigint,
  storage_bytes bigint not null default 0,
  regenerations integer not null default 0,
  estimated_cost_usd numeric not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.generation_costs enable row level security;

-- Solo lectura para el dueño de la solicitud (vía join a video_requests,
-- que ya filtra por auth.uid()). La escritura solo ocurre desde el
-- backend con la service role key (bypassa RLS) — no se otorga ninguna
-- policy de insert/update/delete a los roles anon/authenticated, así que
-- un cliente no puede falsificar sus propios números de costo.
create policy "Users can view their own generation costs"
  on public.generation_costs for select
  using (
    exists (
      select 1 from public.video_requests
      where video_requests.id = generation_costs.request_id
        and video_requests.user_id = auth.uid()
    )
  );
