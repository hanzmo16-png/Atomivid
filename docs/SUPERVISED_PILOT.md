# Piloto supervisado de producción

Hans configura una producción y su presupuesto. Después puede cerrar la app y recibe una entrega para revisar o un aviso claro de bloqueo. Nada se publica sin su aprobación.

El piloto se monta sobre el flujo de podcast, que es el único validado de punta a punta en producción: guion propio, narración con ElevenLabs, video con imágenes de banco y el editor v3.

## Recorrido

1. **Solicitud y guion.** En `/dashboard/podcast`, Hans pega su guion y elige una voz de su cuenta, o sube su propia grabación. Crear el episodio no tiene costo.
2. **Presupuesto total del episodio.** En la página del episodio, «Producción supervisada» muestra tres cifras:
   - **Ya gastado:** el gasto histórico del episodio según el registro de pagos. Los cargos inciertos cuentan como gastados.
   - **Pendiente:** la narración aún no pagada. Si ya está pagada, es USD 0. El video no tiene costo de proveedores.
   - **Mínimo total:** ya gastado + pendiente, redondeado hacia arriba al centavo.
   - Hans fija el presupuesto **total** del episodio. Si lo ya gastado más lo pendiente no cabe, la producción no empieza y no se cobra nada; el mensaje dice el mínimo necesario.
   - La revisión compara el mismo total, así que una producción aceptada al iniciar no puede fallar la comprobación de presupuesto salvo que el costo real supere la estimación. Ese caso se marca aparte como defecto («costó más que su estimación»).
   - **Pendiente neto:** los fragmentos de narración ya pagados y guardados no cuentan como pendientes. Ya están en lo gastado y se reutilizan a USD 0, así que una narración que falló a medias no se cuenta dos veces.
   - **Sin costo nuevo, sin rechazo:** si no queda nada por pagar, ningún presupuesto bloquea, porque no hay dinero en juego. Es el caso de un nuevo montaje con la narración ya pagada. La revisión anota un exceso anterior como nota de severidad baja.
   - **Límite por ejecución (independiente):** cada ejecución que pueda gastar algo nuevo lleva su propio máximo de gasto nuevo autorizado (`run_budget_usd`).
     - Debe cubrir la cota superior de la ejecución: la estimación más el redondeo de la reserva de cada fragmento.
     - La narración se detiene **antes** de cualquier fragmento pagado que pasaría del menor de dos montos: ese límite, o lo que queda del presupuesto total.
     - La narración suelta, corta o en segundo plano, queda limitada a su propia estimación.
   - **Producciones solicitadas antes del límite:** la columna está vacía, porque toda solicitud nueva la escribe. Conservan la autorización que el propietario dio entonces: con las reglas anteriores, `budget_usd` era el máximo de gasto nuevo de esa producción. Siguen limitadas también por el presupuesto total.
   - **Orden de activación sin interrupciones:** primero aplicar la migración, que es aditiva e inocua para el código actual; después desplegar este cambio.
   - **Migración `20261011040000_pilot_run_budget.sql`:** preparada, **no aplicada**. La app lee la columna por separado, así que todo lo demás funciona antes de aplicarla. Sin ella, ninguna producción que necesite pagar narración puede empezar; las que no tienen costo nuevo siguen funcionando.
   - **Cargos inciertos:** un cargo sin confirmar se rechaza al solicitar y al iniciar una programada, además de en el worker.
   - Si el registro de pagos no se puede leer, no empieza nada que dependa del presupuesto. Una producción programada se reintenta en cada tick; pasadas 6 horas sin poder verificarse, se bloquea con un aviso.
3. **Producción.** Puede producir ahora o programar un inicio único.
   - El worker de GitHub Actions narra si hace falta, busca los clips y fotos, monta y verifica.
   - El avance se guarda: Hans puede salir y volver.
   - Un reintento reutiliza todo lo ya pagado.
4. **Revisión.** La pantalla de revisión muestra el video, la duración, el costo, el presupuesto, el tamaño, las comprobaciones técnicas y los defectos detectados.
   - Las comprobaciones confirman la integridad técnica, no la calidad creativa.
5. **Aprobación y publicación.**
   - La publicación queda detenida (`publish_status = held`) hasta que Hans aprueba.
   - Al aprobar pasa a `manual`: Hans descarga el video y lo sube a mano.

## Protecciones

| Riesgo | Protección |
|---|---|
| Gasto por encima de lo aceptado | El presupuesto se comprueba en tres momentos: al solicitar, al iniciar una producción programada y en el worker antes de cualquier llamada de pago. La narración suelta también lo respeta. |
| Cargo incierto | Una llamada de pago abierta sin resultado guardado detiene la producción como **bloqueada** hasta conciliarla. Una llamada con resultado guardado se reutiliza a USD 0. |
| Saldo del proveedor | La admisión vuelve a leer el saldo (GET de facturación). Si el proveedor rechaza por saldo o por techo de gasto, la producción queda bloqueada. |
| Ejecuciones duplicadas | Cada inicio hace un compare-and-set sobre la fila con un token por ejecución. Un segundo inicio mientras otro trabaja recibe 409. |
| Reintentos sin control | Se permiten como máximo 4 reintentos seguidos desde la última entrega. Al 5.º, la producción se detiene y Hans debe revisar. |
| Producción periódica | No existe: la programación es de un solo disparo y nunca crea producciones por sí misma. |

No se cambian los límites globales ni los de los proveedores (`pi_supply_policies`).

## Programación

- **Comprobación en la base de datos:** `pg_cron` revisa cada minuto si hay una producción programada vencida. Solo si la hay, llama a `POST /api/cron/podcast-schedule` mediante `pg_net`.
- **Autenticación de la llamada:** usa un token aleatorio guardado solo en la tabla de servicio `pilot_scheduler_secret`.
- **Inicio:** la app reclama la producción (compare-and-set) y despacha el worker con sus credenciales actuales.
- **Respaldo:** el cron de GitHub del workflow `podcast-video` sigue activo, pero en este repositorio los cron de GitHub llegan con horas de retraso.

## Avisos

- **Cuándo:** solo hay avisos de entrega, de bloqueo y de presupuesto insuficiente. Se envía como máximo uno por ejecución y tipo; no hay avisos por cada paso.
- **Dentro de la app:** aparecen en «Avisos recientes» de `/dashboard/podcast`, con el detalle.
- **En GitHub:** se publica un comentario de `github-actions[bot]` en el issue «Avisos de producción de Atomivid» que menciona a `@hanzmo16-png`. GitHub notifica a Hans por correo o por la app móvil según su configuración.
  - El repositorio es público, así que el comentario solo dice qué pasó y enlaza a la app (requiere iniciar sesión). Los títulos, costos y errores se quedan en la app.

## Conexiones y permisos pendientes

- **Notificaciones de GitHub de Hans.** En github.com → Settings → Notifications deben estar activadas las menciones («Participating, @mentions»), por correo o en la app móvil. Esto no se puede verificar desde aquí: comprobamos que el comentario se publica y que menciona a Hans, pero no que le llegue.
- **Correo propio.** No hay SMTP propio: el correo integrado de Supabase está limitado. El correo de avisos queda pendiente de un SMTP verificado (Resend con dominio, o Gmail con contraseña de aplicación).
- **Subida a YouTube.** Solo está conectado OAuth de lectura. La subida necesita el permiso `youtube.upload`, activar `YOUTUBE_UPLOAD_PRIVATE_ENABLED` y una revisión aparte. Mientras tanto, la publicación es manual.
- **Spotify.** No hay integración. La publicación es manual, desde la descarga.
- **Vercel.** El plan actual permite 100 despliegues al día. Las ramas de operaciones (`claude/video-review`, `ops-sealed-out`) ya no despliegan.
