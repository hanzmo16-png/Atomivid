# Reels: recorrido de prueba para Hans y Director opcional

Estado al 2026-10-12 (rama `claude/director-reels-integration`, basada en la rama por defecto con PR102).
Nada de este documento autoriza gasto: cada Reel real se aprueba aparte, con su tema y su costo.

## Qué está desplegado y qué no

| Pieza | Estado |
|---|---|
| Crear Reel, generar guion, revisar/editar, «Generar video final», historial, reproducir, descargar | Desplegado (rama por defecto) |
| PR102: guion con intención persistente; un resultado incierto bloquea el reintento («No reintentes») | Fusionado y desplegado (a9bc985) |
| Director V1 (propuesta y auditoría) | Solo en PR105 (borrador), apagado |
| Inspección del Director en la revisión de Reels | Solo en este PR (borrador). Flag `CINEMATIC_DIRECTOR_V2_ENABLED` apagado en producción |
| Costo estimado por Reel visual antes de generar | **No existe** en la UI (solo el modo avatar muestra una tarifa de referencia). Lo que limita es la cuota del plan |

## Recorrido desde tu cuenta (flujo actual, sin Director)

1. **Entrar:** `/login` con tu cuenta.
2. **Crear:** `/dashboard/new`.
   - Elige «Reel / Short» (no «Video con avatar»), el tema, el estilo y la duración, y crea la solicitud.
   - Vuelves a `/dashboard` con la tarjeta en estado pendiente.
3. **Guion:** en la tarjeta, pulsa «Generar guion».
   - Esto es **una llamada de pago** a la IA de guion: hace una reserva de unos centavos en el ledger, protegida por PR102.
   - Si sale un error con «No reintentes», **no** pulses de nuevo. Avísame para conciliarlo.
4. **Revisar/editar:** `/dashboard/review/<id>`.
   - Edita texto y conceptos visuales y guarda.
   - Volver a generar el guion completo es **otra llamada de pago**. Esa acción aún no tiene el bloqueo «No reintentes» de PR102: es un hueco conocido, ver Riesgos.
5. **Costo:** antes de generar no se muestra un costo por video para Reels visuales. Revisa tu cuota en el panel. Para una prueba real, decide tú el tema y el límite y autorízalo aparte.
6. **Render:** «Generar video final». Esto consume voz, material visual y render (pago).
   - La tarjeta muestra el progreso.
   - Si falla, la página de revisión muestra el estado. No reintentes a ciegas.
7. **Reproducir y descargar:** `/dashboard/videos/<id>` reproduce y ofrece «Descargar video» con un enlace firmado temporal. También desde el historial en `/dashboard`.

## Cómo probar el Director en la revisión (sin gasto adicional)

Requiere una vista previa (preview) de **este PR** con `CINEMATIC_DIRECTOR_V2_ENABLED=1` en el entorno de la preview. En producción sigue apagado. La decisión de activarlo en una preview es tuya.

En la página de revisión de un Reel visual aparece un panel plegable, «Director (prueba)», con:
- cada plano: tiempos, frase exacta del guion que ilustra, receta, movimiento (real o zoom sobre imagen fija), etiqueta y decisiones pendientes;
- las métricas: cobertura, duración, movimiento real, licencias por revisar, máximo estimado de material nuevo, variedad de recetas y misma receta seguida;
- las observaciones del auditor: códigos como LICENSE_PENDING o DECISION_PENDING.

Lo que **no** hace el panel:
- no cambia el guion;
- no habilita ni bloquea «Generar video final»;
- no llama a ningún proveedor: usa el storyboard **simulado** (`simulateStoryboard`), no el Visual Director de pago;
- no se guarda.

Su contrato es `mode: proposal`, `executable: false`, `paidCalls: 0`.

Para volver al flujo actual, quita el flag o déjalo en 0. El panel desaparece y la página queda idéntica.

## Pasos comprobados y no comprobados

- **Comprobado gratis en CI/local:**
  - flag apagado por defecto;
  - la página solo calcula la inspección detrás del flag y no pasa nada a `ScriptReview`;
  - plan válido 9:16 con cobertura del 100 %;
  - las propuestas manipuladas (`paidCalls: 1`, `executable: true`) se rechazan;
  - el grafo de imports no contiene proveedores, ledger, Supabase ni HTTP;
  - el avatar bloqueado se respeta;
  - la etiqueta de recreación IA se respeta y no se presenta un zoom como movimiento real;
  - `recipeVariety` queda en el rango 0..1.
  - `test:unit`, `test:saas`, `tsc` y eslint pasan.
- **No comprobado:**
  - sesión autenticada real en una preview con el flag encendido;
  - render de un Reel real;
  - calidad visual o semántica, que no se deduce de las métricas del plan;
  - `next build` local. Lo valida la preview o el CI.

## Riesgos y reversión

- Con el flag encendido, la revisión hace un cálculo puro adicional de milisegundos. Si falla, el panel muestra «no disponible» y la generación no cambia.
- Hueco conocido, no tocado aquí: «regenerar guion completo» en `ScriptReview.tsx` (src/app/dashboard/review/[id]/) no tiene aún el bloqueo «No reintentes» de PR102.
- Observación del Director sobre Reels:
  - Con el storyboard simulado, varias escenas pueden recibir la misma receta (p. ej. 3 seguidas de `reel-problem-relatable`). Las palabras clave del catálogo exigen coincidencia exacta, por ejemplo «resultado» frente a «resultados».
  - Es afinado de catálogo pendiente. No se declara calidad.
- **Reversión:** apagar el flag o revertir el PR. No hay migraciones ni datos escritos.
