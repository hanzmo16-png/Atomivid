# Podcast Studio — integridad del guion largo (PR #272, CORRECCION-2)

Cómo se garantiza que un guion de 30 min se puede empezar, cerrar el navegador, retomar y terminar **sin perder trabajo ni pagar dos veces**. También recoge lo que depende de otros PR.

## 1. Un paso se paga como mucho una vez (servidor, sin migración)
- **Antes:** la clave del libro (`pi_paid_operations`) era `script:<paso>:<hash del prompt>`. El estado del trabajo viaja por el navegador, así que un estado modificado abría una operación pagada **nueva** para un paso ya pagado:
  - un turno editado;
  - el contador de ampliaciones rebobinado;
  - dos peticiones simultáneas con contenidos distintos.
- **Ahora:** `withSupplyStepContext` marca el ámbito `stepKeyed` y la clave es **trabajo + nombre del paso + modelo**: `script:<paso>:paso`, sin el contenido.
  - La clave única del libro es la autoridad: el navegador ya no decide qué se paga.
  - Reenviar un paso, con el mismo prompt o con otro, reutiliza su resultado COMMITTED a USD 0.
  - Dos peticiones concurrentes del mismo paso caen en la misma fila: una llama y la otra queda «en curso».
  - El máximo pagable por trabajo es el conjunto finito de nombres de paso: `plan-a1..3`, `s<k>-a1..3` y `s<k>-a<n>-x1..2`.
  - Lo acotan además el tope diario por persona y los topes global y del proveedor.
- **Pruebas:** `src/lib/supply/step-keyed-ledger.test.ts`. Incluye el control que reproduce el doble cobro con la clave antigua.

## 2. Identidad del trabajo
- El servidor **nunca** sustituye en silencio un trabajo recuperable. Un estado de otra configuración (tema, participantes o duración) responde `409 OTRO_TRABAJO`: sin llamar a la IA, sin jobId nuevo y sin devolver otro estado.
- Empezar otro guion exige `state: null` explícito.
- En el asistente aparece el aviso «trabajo-distinto» con dos opciones:
  - «Volver a esa configuración y continuar»: el MISMO jobId, mediante `jobConfigPatch`.
  - «Empezar otro guion»: aparca antes el borrador con sus bloques pagados.
- Ningún error borra `scriptJob` (AGOTADO, ESTADO, reconciliación, red o tiempo).
- Una respuesta tardía de una generación cancelada no escribe nada (`live()`).
- El resultado `done` trae el `jobId`, para vincular el episodio con la autorización durable de #271.

## 3. Recuperación de borradores: un único parser
`src/lib/podcast/v3/draft-recovery.ts` define la clave `atomivid.podcast.asistente.v2.recuperable` y el sobre `{ v: 1, items: [{ raw, at, step }], legacy? }`.
- **Borrador crudo** (formato de 16ab4473): se promueve a ítem, con su `scriptJob.jobId`.
- **Crudo que #269 dejó en `legacy`:** también se promueve.
- **Lo que no es un borrador:** queda en `legacy`, intacto.
- **Sin tope, sin duplicados:** el mismo JSON se mueve al principio en vez de repetirse.
- **Aislamiento por cuenta:**
  - el borrador se guarda con `ownerId`;
  - el borrador activo de otra cuenta se aparca, no se borra;
  - cada cuenta solo ve los suyos, más los anteriores al aislamiento, que no tienen dueño.

**Dependencia de #269 (Cursor).** Su `wizard.ts` duplica el parser y deja el crudo en `legacy`. Para un parser único, #269 debe importar el de este módulo. El cambio es de 3 líneas y está verificado en un worktree efímero (#269 @ 7583bbc7 + #272):
- sin el cambio, la prueba de contrato real falla;
- con el cambio, pasan esa prueba y `wizard-pantallas.test.ts`.

La prueba `scripts/qa/contrato-recuperacion-269-272.test.ts` ejecuta el `wizard.ts` real de #269 junto con `draft-recovery.ts`. No está en `test:podcast3`, que no admite omitidas: se corre en la rama integrada o en un merge efímero de #269 + #272 con `node --import tsx --test scripts/qa/contrato-recuperacion-269-272.test.ts`.
- Con #269 @ 7583bbc7 tal cual: **falla** (0/1).
- Con el parche: **pasa** (16/16, junto con `wizard-pantallas.test.ts` y `draft-recovery.test.ts`).

```diff
@@ -331,27 +331,9 @@ export function entryScreenLabel(step: number): { paso: number; name: (typeof SC
 }
 
 type RecoveryFile = { v: 1; items: ParkedDraft[]; legacy?: string };
+import { parseRecovery } from "./draft-recovery";
 
-function parseRecovery(raw: string | null): { items: ParkedDraft[]; legacy: string | null } {
-  if (!raw) return { items: [], legacy: null };
-  try {
-    const v = JSON.parse(raw) as unknown;
-    if (Array.isArray(v)) return { items: v.filter(isParked).map(normParked), legacy: null };
-    if (v && typeof v === "object" && Array.isArray((v as { items?: unknown }).items)) {
-      const o = v as { items: unknown[]; legacy?: unknown };
-      return { items: o.items.filter(isParked).map(normParked), legacy: typeof o.legacy === "string" ? o.legacy : null };
-    }
-    return { items: [], legacy: raw };
-  } catch { return { items: [], legacy: raw }; }
-}
-
-function isParked(x: unknown): x is { raw: string; at?: unknown; step?: unknown } {
-  return !!x && typeof x === "object" && typeof (x as { raw?: unknown }).raw === "string" && (x as { raw: string }).raw.length > 0;
-}
-function normParked(x: { raw: string; at?: unknown; step?: unknown }): ParkedDraft {
-  return { raw: x.raw, at: typeof x.at === "string" ? x.at : "", step: Number.isFinite(Number(x.step)) ? Number(x.step) : storedDraftStep(x.raw) };
-}
-
+// Parser ÚNICO de la clave recuperable, compartido con «Empezar de nuevo» (#272): crudo → ítem, legado intacto, sin tope.
 export function recoveryList(raw: string | null): ParkedDraft[] {
   return parseRecovery(raw).items;
 }
```

## 4. Dependencias de #271 (sin migración en este PR)
- **Conflictos textuales:** `package.json`, `PodcastWizard.tsx` y `guion-largo.render.test.tsx`.
- **Al resolver:**
  - conservar `runScriptGeneration`;
  - **no** reintroducir `set({ scriptJob: null })` en los errores;
  - tomar `scriptJobId` de `result.jobId` en `done`.
- La clave por paso (`script:<paso>:paso`) no afecta al SQL de #271, que filtra por `project_id`, no por `shot_id`.
- **#271 sigue sin resolver la autorización durable**, según Grok:
  - falta el emparejamiento exacto de `authorization_ref`;
  - falta el triple explícito en el submit.
  - No se aplica la migración ni se enciende `PODCAST_STUDIO_SCRIPT_DURABLE_AUTH`.

## 5. Riesgos económicos residuales (acotados, documentados)
- **Tope diario:** es una lectura antes de la llamada. Dos peticiones simultáneas de trabajos distintos pueden pasar las dos con un gasto ya cercano al tope.
  - Lo acota la concurrencia del proveedor: 1 llamada simultánea, aplicada de forma atómica al pasar a SUBMITTED.
  - El cierre durable (tope atómico en SQL o autorización por trabajo) es tarea de #271 y requiere migración.
- **Cambio de `ANTHROPIC_SCRIPT_MODEL` a mitad de un trabajo:** un paso puede pagarse una vez más, con el modelo nuevo. Exige un cambio de configuración del operador.
- **Despliegue de esta versión con un paso en curso:** el paso en curso cambia de clave (de hash a nombre) y puede pagarse una vez más. Como máximo un paso por trabajo activo.
- **«Empezar otro guion»** es una producción nueva y explícita: cuenta para el tope diario. No es un doble cobro.
