# Muestras audiovisuales reales — 26 septiembre 2026

Estado: producción técnica completada; calidad audiovisual NO aprobada para clientes.

Run: https://github.com/hanzmo16-png/Atomivid/actions/runs/36247806447
Código ejecutado: 81ea364b86e2f311bd49d1bc84ebbb13ef23fa6a
Correcciones: PR #14, dirigido a la rama del PR #13. Sin merge, despliegue de producción ni migraciones.

## Resultados medidos

| Muestra | Duración MP4 | Video | Audio integrado / pico | Acumulado contabilizado |
|---|---:|---|---|---:|
| Horror | 33,0 s | 1080×1920, H.264, 30 fps | −16,4 LUFS / −2,4 dBFS | US$0,200456 |
| Cómic | 30,3 s | 1080×1920, H.264, 30 fps | −16,1 LUFS / −2,4 dBFS | US$0,463545 |
| Total | | | | US$0,664001 |

Ambos MP4 decodifican sin errores. No se detectaron tramos negros de ≥0,15 s con blackdetect, pix_th=0.06 y pic_th=0.98. Inspección visual: hojas de contacto cada 3 s, no revisión de cada fotograma. El audio no se escuchó; las cifras son mediciones, no aprobación de la música o la voz.

Tope autorizado: US$1 total y US$0,75 por muestra. Quedan US$0,335999 del tope global. El total incluye US$0,08 conservados del primer intento incierto; la consola mostró tres llamadas de 2415 tokens de entrada y 2000 de salida, equivalentes a US$0,07449 a las tarifas registradas. No se redujo la reserva. Voz: estimación por caracteres; guion e imágenes: tokens medidos × tarifas registradas. Esto no sustituye la factura de los proveedores.

Horror: voz US$0,0449; guion e intentos anteriores US$0,155556.
Cómic: guion US$0,02708; seis imágenes US$0,332865; voz US$0,0518 y corrección de duración US$0,0518.

## Hallazgos de calidad

1. Horror sí resolvió Suspenso / Tension Dark / ritmo pausado. Sin embargo, cerca de los segundos 9–12 aparecen personas sonrientes conversando mientras la narración habla de desconcierto y desaparición. Oscurecer stock no corrige una acción incompatible. No aprueba coherencia semántica.
2. Cómic conserva una apariencia ilustrada reconocible. El faro cambia de diseño: blanco con remate oscuro al inicio y franjas rojas al final. Falta continuidad del mismo escenario.
3. La selección de la muestra Cómic contenía solo profile=comic, con tono Curiosidades; no tenía intención explícita de suspenso. Resolvió informative desde style_weak, música Minimal Sparse y ritmo balanced. El guion terminó explicando el apagón por un ave. Por tanto, no demuestra la aceptación de cómic de misterio ni anticipación/revelación; no presentar el render como aprobado.
4. Los guiones son relatos de prueba generados, sin verificación de hechos ni fuentes. No usarlos como documentales factuales.
5. Se necesita valoración auditiva y emocional de Hans antes de aprobar cualquier muestra.

## Correcciones implementadas y comprobadas

- Thinking desactivado explícitamente en la capa compartida de guiones cortos y reescritura de escenas. El run previo agotaba 2000 tokens en bloques thinking y no devolvía texto.
- Corrección de longitud recibe el borrador anterior y el delta de palabras. En el run real Cómic pasó de 98 a 83 palabras en una corrección.
- Los borradores pagados y su control de calidad se conservan en Storage y artifact antes del rechazo; no se guardan como script.json aprobado si fallan.
- 82 pruebas relacionadas, TypeScript después de next typegen y ESLint de los archivos fuente pasan. El runner está excluido por la configuración existente de ESLint; sí pasó typecheck.
- Registro acumulado, límites y bloqueos por incertidumbre conservados.

## Próximo trabajo antes de más gasto

- Configurar la intención de suspenso de la muestra Cómic antes de escribir el guion y comprobar la dirección esperada ANTES de pagar imágenes o voz.
- Revisar el flujo de producto para que una intención ambigua quede visible al cliente antes de producir; no confundir estilo gráfico con género narrativo.
- Rechazar stock cuya acción contradiga la escena, en particular conversaciones sonrientes para miedo/desaparición.
- Mantener la identidad del escenario entre imágenes.
- Preparar una corrección que reutilice recursos aprobados; calcular el presupuesto por operaciones pendientes. El presupuesto de Cómic restante por muestra es US$0,286455, inferior a la reserva de seis imágenes nuevas (US$0,42). No regenerar toda la serie dentro de esta autorización.
