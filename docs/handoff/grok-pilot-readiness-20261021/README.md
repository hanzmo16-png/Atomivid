# Parches de Grok sobre PR176 (`claude/recraft-integration` @ bd94dcaa)

El token de Grok no tiene scope `workflow`, y una rama nueva basada en PR176 arrastra cambios de `.github/workflows/*` → GitHub rechaza el push.
Por eso los commits van aquí como parches `git am`, en orden, sobre bd94dcaa (probados allí: commits locales 981f7164 → a5bc5a77):

1. `0001` fix(long-form): hardMax vigente en reintentos (hallazgo estático de ChatGPT). RED A2-9 → GREEN 12/12.
2. `0002` feat(long-form): voz elegida al confirmar (El Duro), nunca sustituida. Toca `confirm-production/route.ts`,
   `ConfigureProduction.tsx`, `page.tsx` y `confirm-production.ts` (archivos de PR176) — por eso NO va en esta rama. RED 4/17 → GREEN 17/17.
   Migración `20261021180000_long_form_voice_selection.sql` (verificada en PG desechable: `supabase/migrations/verify/long_form_voice_selection.sql`).
3. `0003` chore(harness): ensayo con catálogo de voces, cola/saldo fal simulados y guion Marco Aurelio.
4. `0004` fix(recraft): fila `recraft` en `pi_provider_accounts` (FK de `pi_capacity_snapshots`).
5. `0005` chore(harness): arreglos del ensayo.

Aplicar: `git checkout claude/recraft-integration && git am docs/handoff/grok-pilot-readiness-20261021/000*.patch`.
- 0006: coverVideoTail (gap_at_end float, R8) + f-player.cjs.

## Rebasados sobre PR176 c5a9ab15 (10:50 UTC-5)
`sobre-c5a9ab15/0001–0006`: `git am -3` limpio sobre c5a9ab15. Conflictos resueltos solo en imports/estado (route.ts, ConfigureProduction.tsx, produce.ts); se conserva el default Recraft-first de Claude.
Tests sobre el resultado: request-budget 9/9, long-form-voice 3/3, confirm-production 14/14, confirm-production-route 3/3, video-tail 3/3, produce 5/5. tsc: solo LayoutProps (tipos .next no generados, ambiental).
