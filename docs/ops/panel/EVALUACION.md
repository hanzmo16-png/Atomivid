# M5 · Evaluación del panel operativo y financiero

Estado: borrador. Base: árbol candidato #207 (`d8b203d`). Todo lo implementado en M5 usa **datos sintéticos**; no se leyó Supabase de producción ni se llamó a ningún proveedor.

## 1. Qué muestra hoy el Command Center

Página: `src/app/dashboard/command-center/page.tsx` (solo OWNER/ADMIN, `force-dynamic`, cliente de servicio). Compone:

| Bloque | Componente | Fuente de datos | Qué muestra |
|---|---|---|---|
| Overview / Production / Costs / Providers / YouTube / System health | `CommandCenterView.tsx` ← `src/lib/command-center/view-model.ts` ← `aggregate.ts` ← `sources.ts` | `video_requests`, `generation_costs`, `pi_paid_operations` (filtrado por `updated_at`), `pi_capacity_snapshots`, `fc_qa_decisions`, `yt_*` | Conteos por tipo/estado, COGS (`actualCogsUsd`), "reservado", costo por proveedor, capacidad por proveedor, trabajos atascados > 2 h |
| Suministro de producción | `SupplyPanel.tsx` ← `src/lib/supply/admin.ts` | `pi_supply_policies` (topes diario/mensual), RPC `pi_supply_state`, `pi_supply_alerts`, `video_requests` en espera | Nivel por proveedor, saldo libre, cobertura, topes configurados |
| Respaldo de videos pendientes | `FinancePanel.tsx` ← `src/lib/supply/obligations-server.ts` / `obligations.ts` | `subscriptions`, `video_requests`, `pi_supply_job_reservations`, tarifas `SUPPLY_RESERVE_*_USD` | Cuotas sin usar, reserva recomendada (+30 %); "Dinero libre para publicidad" = Sin verificar |

## 2. Brechas frente a lo pedido

| Métrica | Hoy | Brecha |
|---|---|---|
| Gasto por proveedor | `aggregateCosts().byProvider` suma COMMITTED + `generation_costs` | Solo confirmado; no separa incierto; redondeo a 2 decimales con `Math.round(x*100)/100` sobre floats (`aggregate.ts`, `r2`) → deriva posible |
| Gasto por periodo | Ventanas TODAY/7D/28D/MTD/LIFETIME (`windows.ts`) | No hay serie por día; `pi_paid_operations` se filtra por `updated_at`, no por `created_at` (los topes del SQL usan `created_at`) |
| Costo por video | `costByProduction` solo desde `generation_costs` (legado) | No incluye `pi_paid_operations` por `project_id`; no distingue costo final de costo pendiente |
| Gasto incierto | `reservedUsd` suma RESERVED **junto con** SUBMITTED/PJR/RR | Mezcla "no se llamó al proveedor" (RESERVED) con "el proveedor pudo cobrar" (SUBMITTED/PJR/RR); ignora REFUNDED sin conciliar (que el SQL sí cuenta, ver `pi_supply_state` en `supabase/migrations/20261005143935_provider_supply_controls.sql`) |
| Trabajos activos | `byState.running`, `staleRunning` (video_requests) | No muestra llamadas activas al proveedor (SUBMITTED/PJR) |
| Errores / fallidos | `byState.failed` | No muestra RECONCILIATION_REQUIRED ni reembolsos sin conciliar |
| Topes y holgura | `SupplyPanel` muestra topes configurados; `pi_supply_state` devuelve `dailySpend`/`monthlySpend` | El panel no muestra consumo vs tope ni holgura; topes por proyecto (`video_requests.provider_spend_cap_usd`, `pi_recovery_budgets.cap_usd`, `pi_spend_authorizations.cap_usd`) no se muestran |
| Margen | `mrrUsd` = UNAVAILABLE ("revenue requires Stripe reconciliation") | Ver §3 |

## 3. Fuente de precio

- Existe un **precio de lista mensual por plan** (`src/lib/billing/plans.ts`, `priceUsdPerMonth` 19/49/129). Es precio de suscripción, no precio por video ni cobro real.
- No hay ingreso real conciliado (Stripe) en el panel (`aggregate.ts`: `mrrUsd` UNAVAILABLE).
- Conclusión: **no existe fuente de precio por video verificable**. El módulo M5 acepta precios por proyecto como entrada opcional con su `basis`; sin ellos muestra "Sin fuente de precio". En el fixture sintético los precios son explícitamente "precio de ejemplo".

## 4. Qué se implementó (M5, datos sintéticos)

- `src/lib/ops-panel/metrics.ts` — agregación pura. Enteros de diezmilésimas de USD (BigInt, escala de `numeric(12,4)`), salida como cadenas de 4 decimales. Semántica idéntica a `pi_supply_state`/`pi_submit_with_supply`:
  - RESERVED → "reservado sin gastar", nunca gasto.
  - SUBMITTED / PROVIDER_JOB_RECORDED / RECONCILIATION_REQUIRED → gasto incierto (reserva).
  - COMMITTED → `coalesce(committed_usd, reserved_usd)`, contando cuántos usan la reserva.
  - REFUNDED + `supply_reconciled` → liberado (0); REFUNDED sin conciliar → incierto.
  - Estado desconocido → incierto (fail-closed). `method = 'capacity_hold'` → excluido.
  - Consumo contra topes = `greatest(reserved_usd, committed_usd)` desde inicio de día/mes por `created_at`.
  - Separación de fuentes: la entrada declara `source.kind` y cada fila su `origin`; si no coinciden → `MIXED_DATA_SOURCES`.
- `src/lib/ops-panel/fixture.ts` — fixture SINTÉTICO (ids `sintetico-*`).
- `src/app/dashboard/command-center/OpsMetricsPanel.tsx` — presentación con insignia de fuente (`SINTÉTICO · datos de ejemplo` / `Datos reales`), estados vacío y error. **No** está conectado a `page.tsx`; no se añadió ruta.
- Pruebas: `src/lib/ops-panel/metrics.test.ts`, `src/app/dashboard/command-center/ops-metrics-panel.test.tsx`, incluidas en `npm run test:spend`.

## 5. Lo que requiere autorización antes de usar datos reales

1. Lectura de producción (`pi_paid_operations`: `project_id, provider, method, status, reserved_usd, committed_usd, supply_reconciled, created_at`, paginada como `obligations-server.ts`), `pi_supply_policies` (topes y `timezone`), `video_requests` (estado), topes por proyecto. No hace falta una vista nueva: son columnas existentes. Los importes deben llegar como texto de `numeric` para conservar la exactitud.
2. Resolver `dayStartIso`/`monthStartIso` en la zona de `pi_supply_policies.timezone` del lado del servidor.
3. Una fuente de precio por video verificable (p. ej. ingresos conciliados de Stripe asignados a cada video). Hasta entonces el margen real queda "Sin fuente de precio".
4. Decidir si el panel sustituye a `aggregateCosts().reservedUsd` (que hoy mezcla RESERVED con incierto) o convive con él; no se cambió el comportamiento existente.
