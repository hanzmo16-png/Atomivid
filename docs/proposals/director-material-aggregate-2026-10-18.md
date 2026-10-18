# PROPUESTA (no aplicada) — tope agregado de material nuevo del Director por producción

Estado: **NO_GO hasta aprobación del propietario y auditoría.** Este archivo vive en `docs/` y **no** en `supabase/migrations/` a propósito: el workflow `apply-supabase-migration.yml` aplica todas las migraciones pendientes de esa carpeta, y esto no debe aplicarse por accidente.

## Problema que resuelve
Hoy (PR #148, anexo C1) el tope de material nuevo del Director se reserva **por intento**, en el sobre del proveedor de imagen de ese intento. Cada reintento puede aprobar otro tope, hasta USD 2 y por decisión explícita del propietario. Por tanto, el gasto acumulado de una producción a través de sus intentos no tiene un techo durable propio; solo lo acotan los topes diarios y mensuales del proveedor.

## Diseño
1. **Columna nueva** `video_requests.owner_material_approved_usd numeric not null default 0`, con `check (owner_material_approved_usd >= 0 and owner_material_approved_usd <= 10)`. Es el **total** aprobado para la producción.
2. **RPC** `pi_approve_owner_material(p_request_id uuid, p_total_usd numeric)`. La llama solo la ruta de render, para el propietario y con `service_role`. Con `FOR UPDATE` sobre la fila:
   - suma lo **consumido** en todos los intentos: `consumed_usd` de `pi_supply_job_reservations` del proveedor de imagen de esa solicitud, más las operaciones `generate_image` con shot `image:director-fill-*` en estado `SUBMITTED`/`RECONCILIATION_REQUIRED`, que cuentan como posible cobro;
   - rechaza si `p_total_usd` < consumido + incierto;
   - fija el total;
   - devuelve el **remanente** = total − consumido − incierto.
3. **Ruta de render:** reserva en el sobre del intento `min(remanente, tope por intento)`, en vez del valor tal cual del navegador.
4. **Worker:** sin cambios. Sigue leyendo solo su sobre (`directorMaterialBudgetUsd`).

## SQL propuesto (borrador para revisión)
```sql
alter table public.video_requests
  add column if not exists owner_material_approved_usd numeric not null default 0
  check (owner_material_approved_usd >= 0 and owner_material_approved_usd <= 10);

create or replace function public.pi_approve_owner_material(p_request_id uuid, p_total_usd numeric, p_image_provider text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v record; consumed numeric; uncertain numeric;
begin
  if p_total_usd is null or p_total_usd < 0 or p_total_usd > 10 then return jsonb_build_object('ok', false, 'reason', 'invalid total'); end if;
  select * into v from public.video_requests where id = p_request_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'request not found'); end if;
  select coalesce(sum(consumed_usd), 0) into consumed from public.pi_supply_job_reservations
    where project_id = p_request_id::text and provider = p_image_provider;
  select coalesce(sum(reserved_usd), 0) into uncertain from public.pi_paid_operations
    where project_id = p_request_id::text and method = 'generate_image' and shot_id like 'image:director-fill-%'
      and status in ('SUBMITTED', 'RECONCILIATION_REQUIRED');
  if p_total_usd < consumed + uncertain then
    return jsonb_build_object('ok', false, 'reason', 'total below spent', 'spent', consumed, 'uncertain', uncertain); end if;
  update public.video_requests set owner_material_approved_usd = p_total_usd where id = p_request_id;
  return jsonb_build_object('ok', true, 'remaining', p_total_usd - consumed - uncertain, 'spent', consumed, 'uncertain', uncertain);
end $$;
revoke all on function public.pi_approve_owner_material(uuid, numeric, text) from public, anon, authenticated;
grant execute on function public.pi_approve_owner_material(uuid, numeric, text) to service_role;
```

## Reversión
```sql
drop function if exists public.pi_approve_owner_material(uuid, numeric, text);
alter table public.video_requests drop column if exists owner_material_approved_usd;
```
La reversión es segura: el código anterior no lee la columna, y sin la RPC la ruta vuelve al tope por intento.

## Riesgos y pruebas antes de aplicar
- `consumed_usd` del sobre de imagen incluye las imágenes normales del Reel, no solo las del relleno. Hay que separar por `shot_id` del ledger (más preciso) o aceptar el sobre como cota superior conservadora.
- Las pruebas ROJO/VERDE deben cubrir, con concurrencia real de Postgres:
  - dos inicios concurrentes del mismo request;
  - reintento tras un gasto parcial;
  - llamada incierta;
  - total menor que lo ya gastado.
