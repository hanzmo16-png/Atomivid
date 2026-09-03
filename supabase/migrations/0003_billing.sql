-- Atomivid — Paso 3: suscripción de pago con Stripe
-- Guarda el estado de la suscripción de cada usuario. Todas las escrituras
-- ocurren desde el backend (checkout + webhook de Stripe) con la service
-- role key; el usuario solo puede leer su propia fila.

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  status text not null default 'none',
  price_id text,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.subscriptions enable row level security;

create policy "Users can view their own subscription"
  on public.subscriptions for select
  using (auth.uid() = user_id);
