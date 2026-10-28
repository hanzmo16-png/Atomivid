# Registro persistente — cierre Podcast / Long Form (sin secretos)

Formato: hora UTC · acción · resultado · gasto. Las evidencias cifradas están en la rama `claude/evidencias-cierre`.
Clave de evidencia: se rota por sesión. La privada vive solo en el contenedor y no se guarda fuera de él (una copia en
Drive fue bloqueada como fuga de credenciales). Cada evidencia se revisa en la misma sesión y aquí queda su resultado.
Evidencias cifradas con claves anteriores (hasta el commit 6885d18) ya no se pueden descifrar. Sus resultados son los
anotados abajo, revisados en su momento.

## Estado de producción
- 2026-10-28 10:44 · #239 (Podcast: cuota de llamadas + imágenes del tema) → c5ec682, Vercel OK.
- 10:57 · #240 (LF: carrera reconfigurar/reintentar) → cb750b5, Vercel OK.
- 11:02 · #241 (LF: palabras de encuadre + tarjeta del pasaje ≤ 15 %) → c7aca5f, Vercel OK.
- 11:49 · PR #242 (LF: sujetos compuestos + categorías) abierta, CI en curso.

## Cuotas internas (sin cambiar topes USD)
- 09:53 · elevenlabs max_daily_calls 14→300; heygen 4→40 (run 40667685614).

## Podcast (cerrado)
- 10:02 · P2 3fcb1b37 (reintento) READY, USD 0.8618 total; 4 planos vacíos (corregido en #239).
- 10:55 · P2 eb4dc21d READY: 38.1 s, 1080p, −16.1 LUFS, USD 0.8518; dos identidades; imágenes del tema en todos los turnos.
- 11:03 · descargas MP4 + MP3 de eb4dc21d OK (run 40676581468, USD 0).
- Gasto Podcast acumulado ≈ USD 3.08 / 4.

## Long Form — sabana (solicitud hash:c14f1e)
- Ledger LF desde 2026-10-27, leído a las 11:04 por el arnés: USD 1.2863 en 26 operaciones (incluye guion USD 0.37). Tope 12.
- 09:52 · run 40667185349: Económico, parada a USD 0, 29 escenas sin material.
- 11:06 · run 40676906308 (tras #241): parada a USD 0, 19 escenas sin material (límite 15 %).
- 11:44 · diagnóstico 40677547477: 16 escenas sin candidato. 7 huecos reales (collar GPS ×4, calima, sol de mediodía,
  terreno estacional); el resto corresponde al emparejador → #242.
- 12:15 · #242 fusionado → 2d20b92 (CI completa en verde en 3b40338). Vercel producción OK a las 12:16:20.
- 12:17 · LF relanzado (prueba-real caso=lf, presupuesto 12, reconfigurar → Económico), run 40686457952. Techo autorizable 8.61 (incluye guion 0.37); peor caso acumulado ≈ USD 9.53 / 12.
- 12:07 · Rutina Drive: sin pendientes (auditoría 06:11 de ChatGPT = HITO_VERIFICADO; no se escribió nada).
- 12:50 · run 40686457952 cancelado: el plan quedó confirmado (long_form_confirmed_at) pero la producción nunca se inició; el arnés esperaba sin límite. Arnés 91bc107: captura de respuestas confirm/render y parada a los 5 min.
- 12:54 · run 40691139761: falla en ~4 min sin gasto. Causa: la página de configuración redirige a la del video (plan confirmado, sin iniciar), que ofrece «Iniciar producción»; ConfigureProduction llama confirm-production y luego /render, y fue esa segunda llamada la que no inició.
- 13:2x · arnés 2cf0134: inicia el plan confirmado desde la página del video y registra la respuesta de /render. Run 40693990357 en curso.
- Evidencias: clave de cifrado rotada por sesión (6885d18); la privada no se persiste (Drive bloqueado por política); cada evidencia se descifra y revisa en la misma sesión y su resultado queda aquí.
- 13:15 · run 40693990357: /render → 409 «máximo de 3 intentos». Causa raíz: las tres paradas de material a USD 0 consumieron un intento cada una y «Volver a configurar» no lo devuelve. Gasto: sin cambios (ledger LF USD 1.2863, 26 ops).
- 13:55 · PR #243: el inicio de un plan reconfigurado con intentos agotados se permite solo con prueba del ledger de gasto de producción 0 (tope duro +3). Pruebas unitarias 2428/0, typecheck y lint OK.
