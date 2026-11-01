# Podcast Studio 3.0 — prueba real controlada del guion largo (PENDIENTE, no ejecutada)

Esta prueba confirma con el modelo real lo que las pruebas simuladas no pueden probar. Se ejecuta **solo después** de:
- la auditoría de Grok;
- la autorización específica de Hans para el gasto y para desplegar este PR.

Las pruebas automáticas usan respuestas simuladas, incluida la de 6.577 caracteres del incidente. **No prueban la integración real.**

## Qué se valida
- Anthropic devuelve bloques cuya longitud real, medida en palabras, coincide con lo pedido a 5,3 car./palabra.
- La admisión del libro de gastos (`studio-script:<dueño>:<trabajo>`) pasa de `RESERVED` a `COMMITTED`.
- Reintentar después de cortar la red no crea operaciones nuevas.
- El guion final de BASE DULCE dura 27–33 min.

## Presupuesto
| Concepto | Estimación |
|---|---|
| Llamadas (30 min) | escaleta + 3 bloques = 4; con ampliaciones, máximo 4 + 2 × 3 = 10 |
| Costo esperado | USD 0,10–0,15 (tarifas del libro: 2 USD/M de entrada, 10 USD/M de salida) |
| Reserva máxima | ≈ USD 0,35 sin ampliaciones; tope duro < USD 1 |
| Tope a autorizar | **USD 1** |
| Otros proveedores | ninguno: sin voz, imágenes, avatares ni MP4 |

## Pasos (en la interfaz real, con la cuenta del dueño)
1. Podcast Studio → «Empezar de nuevo».
2. Elige un formato de diálogo con Valeria Moncler y El Duro Hans, en español y 30 min.
3. Tema: «BASE DULCE: LOS SIETE NIVELES DEL HORROR. Conversación de 30 minutos entre Valeria Moncler y El Duro Hans. Explorar Thomas Castello, Phil Schneider, los supuestos siete niveles subterráneos, la batalla de 1979 y Paul Bennewitz. Estilo cinematográfico, intrigante, conversacional, con humor inteligente y escepticismo. Distinguir afirmaciones, rumores y evidencia verificable».
4. Pulsa «Generar conversación desde el tema».
   - Se verá «Escaleta lista…» y luego «Bloque k de 3…». Si aparece «Ampliando el bloque k», también es válido.
5. **Corte de red:** durante el bloque 2, desconecta la red unos 10 s.
   - Debe verse «Se interrumpió la conexión con el servidor… Reintentando».
   - Al volver la red, sigue sola. Si se agotan los reintentos, aparece «Continuar la conversación (bloque 2 de 3)».
6. **Recarga:** con un bloque a medias, recarga la página.
   - Aparece «Retomaste tu borrador…» y «Continuar la conversación (bloque k de 3)».
   - Al continuar, termina sin repetir bloques.
7. **Reinicio:** al final, pulsa «Empezar de nuevo».
   - El borrador queda vacío y aparece «Recuperar el borrador anterior».
   - No aparece «Continuar…».

## Criterios de aceptación
- [ ] La nota final dice «unos X min para 30 pedidos», con X entre 27 y 33.
- [ ] El guion contiene a los dos anfitriones, menciona Castello, Schneider, Bennewitz y 1979, y no contiene ninguna frase de la plantilla.
- [ ] Ningún turno repetido; el saludo solo aparece en el bloque 1 y la despedida solo al final.
- [ ] En el libro de gastos, `pi_paid_operations` con `project_id like 'studio-script:%'`:
  - todas las filas en `COMMITTED`;
  - una sola por clave de paso (`script:plan-a1`, `script:s0-a1`, …), sin duplicados tras el corte de red;
  - suma ≤ USD 1.
  - Se comprueba con el caso de solo lectura `pod-guion-diag` del arnés.
- [ ] No se creó ningún episodio, voz, imagen ni MP4.

## Riesgos conocidos
- La política de Anthropic de la plataforma admite 20 llamadas al día y 1 simultánea para todos. Si otro proceso ocupa la única llamada simultánea, el estudio responde «otra generación con IA está en curso».
- La autorización duradera por trabajo (T-20261101-1520) sigue pendiente de decisión. Hasta entonces acotan el gasto:
  - los topes de la plataforma;
  - USD 3 al día por persona;
  - 3 intentos y 2 ampliaciones por bloque.
