# FLUX: activación controlada en producción (para autorizar)

Estado del código: FLUX ya está en producción (#291) **apagado**. Con `FLUX_IMAGES_ENABLED` sin definir nadie ve la opción, ni la cuenta dueña.
Contrato del proveedor, precios y prueba real de una imagen: `docs/FLUX_FAL.md`.

## Evidencia gratuita que respalda este procedimiento
| Qué | Dónde |
|---|---|
| Estado real de la migración en Supabase (solo lectura) | workflow `flux-schema-readonly`, línea `ESTADO_PRODUCCION` |
| Aplicar → re-aplicar → rollback → re-aplicar, sobre **el esquema de producción** en un Postgres desechable | mismo workflow |
| El rollback se niega si existe un video FLUX, sin tocar datos | mismo workflow |
| Inserciones Reel y Long Form, Recraft intacto, política `flux` cerrada | `supabase/migrations/verify/flux_image_source.sql` (lo ejecuta el workflow) |
| Modelo activo, `FAL_KEY` válida, precio y saldo (USD 0) | `flux-real-test.yml` en modo `preflight` |

## Activación (cada paso requiere la autorización expresa de Hans)
1. **Migración** (aditiva; el código desplegado nunca escribe `'flux'`):
   - Actions → *Aplicar migración de Supabase* → `migration_file` = `20261113150000_flux_image_source.sql`.
   - Antes y después, el propio workflow verifica el esquema. Después, re-ejecutar `flux-schema-readonly`: debe decir `ESTADO_PRODUCCION migración FLUX APLICADA`.
   - **Respaldo previo:** no hace falta copiar datos. La migración solo reemplaza un CHECK e inserta 2 filas de configuración, y el rollback deja exactamente el estado anterior.
2. **Política de gasto** `flux` en `pi_supply_policies`: sigue **cerrada** (`enabled=false`, topes 0) hasta que Hans apruebe topes financiados. Mientras esté cerrada, cualquier video FLUX espera «disponibilidad» sin cobrar.
3. **Piloto solo dueño:** `FLUX_IMAGES_ENABLED=owner` en Vercel (Production) y en la variable del repositorio que lee `render.yml`. Después, redeploy.
4. **Prueba real** (requiere autorizar el importe): un Reel corto con FLUX desde el celular de Hans, con unas 6–10 imágenes a USD 0,025 cada una, es decir unos USD 0,15–0,25 más la voz. Solo después de verlo terminado se puede declarar FLUX funcional en producción.
5. Apertura general (opcional): `FLUX_IMAGES_ENABLED=true` y redeploy.

## Rollback (en orden inverso, sin perder datos)
- Inmediato y sin código: quitar `FLUX_IMAGES_ENABLED` en Vercel y en la variable del repositorio, y redeploy. Nadie vuelve a ver FLUX.
- Gasto: `enabled=false` en la política `flux`. Lo pendiente queda en espera y no se cobra.
- Esquema: `supabase/rollbacks/20261113150000_flux_image_source.rollback.sql`. Se **niega** si existe algún video FLUX, así que nunca borra ni altera datos de clientes. Probado en el workflow.

## Lo que NO está probado (no declarar)
- Una generación real con FLUX en producción: necesita los pasos 1–4 y la autorización del importe.
