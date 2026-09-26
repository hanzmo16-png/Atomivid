# Cierre de presentación y entrega de YouTube

Feedback de Hans, 25 de septiembre de 2026 (Cancún): la miniatura y el resto
de la muestra están bien; el tema «Canal de Panamá» debe dominar visualmente.
«Cavando una montaña» es la frase secundaria. Se pide terminar y pulir el flujo.

## Correcciones preparadas

- El editor distingue «Título principal (grande)» y «Frase secundaria
  (pequeña, opcional)». Los ejemplos de Panamá respetan esa jerarquía.
- La sugerencia «Cómo se construyó el Canal de Panamá» conserva «Canal de
  Panamá» en portada y miniatura, sin truncar el nombre.
- La pantalla de resultado usa URLs con la opción de descarga de Storage,
  manteniendo las URLs de reproducción y vista previa sin cambios.
- Solo busca la miniatura cuando el plan confirmado la pide. Si falta,
  muestra un aviso y conserva la descarga del video.
- «Crear otro video» desde un documental lleva al formulario Long Form.

## Validación local

- 46 pruebas aprobadas: reglas de portada, presentación, confirmación,
  ejecución del pipeline y pantalla de resultado.
- `next typegen` + `npm run typecheck`: aprobados.
- ESLint de los archivos TypeScript modificados y `git diff --check`: aprobados.
- El pipeline se probó con proveedores simulados: ninguna llamada pagada.
- No hay nueva imagen renderizada: el intento local de Remotion falló al
  consultar interfaces de red (`uv_interface_addresses`, EPERM), antes de
  generar el JPG. Las capturas anteriores siguen mostrando el diseño previo.
- La conexión Vercel devolvió cero equipos; no se verificó el despliegue.

## Secuencia pendiente para cerrar

1. Integrar esta corrección en la rama de calidad visual y preparar su
   integración con la rama principal. Verificar el commit exacto publicado.
2. Regenerar la miniatura de Panamá con los medios ya guardados, sin llamar
   a proveedores. Revisar el resultado a 1280×720 y a tamaño de celular:
   tema completo, tildes, sujeto, contraste y zona de duración.
3. Verificar la apertura dentro del MP4 final y el montaje completo:
   movimiento inicial, ausencia de repeticiones innecesarias, subtítulos,
   sincronía, música y cierre. La muestra aprobada no acredita por sí sola
   todo el documental.
4. Desde una cuenta autorizada: configurar, confirmar, ver progreso,
   regresar al historial, reproducir y descargar MP4 y JPG. Repetir acceso
   después de recargar. No iniciar generaciones pagadas sin presupuesto
   autorizado para esa prueba.
5. Probar el fallo de miniatura y su recuperación independiente. El aviso
   está implementado; todavía no existe un botón de regeneración aislada.

No considerar el producto cerrado hasta completar las comprobaciones en
el despliegue real. Esta lista no declara esas comprobaciones realizadas.
