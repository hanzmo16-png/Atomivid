# Registro — mejoras de Podcast (estudios, Recraft, anfitriones, avance)

Sin secretos. Gasto en USD; «aprox.» = tarifa publicada × solicitudes enviadas (fal no devuelve el costo).

## Diagnóstico (USD 0)
- 2026-10-28 15:20 · run 40716132170 (pod-diag): episodio b9c6784d = Podcast 3.0 estudio, diálogo; Hans (avatar propio, voz
  clonada «duro hans» CeFSZuaHs4SxcBxb9nCr) + Valeria (avatar asset dcf70e13, voz **Callie 7YaUDeaStRuoYg3FKsmU**).
  Pedido 5 min → 378,6 s; guion 5.044 caracteres (plantilla con bloques repetidos), 13,5 car./s reales. Costo del episodio
  USD 6,9097 (26 voces ElevenLabs 1,0097 + 13 clips HeyGen 5,90). Proveedor visual: Pexels.
- Causas confirmadas en el código: Pexels con etiquetas que incluían las palabras de la búsqueda (adapters.ts); Recraft sin
  adaptador en el estudio; retratos con su fondo original sobre un degradado (compose.ts); «En cola…» cuando el progreso
  aún no tenía una etapa conocida (PodcastWizard.tsx).
- 15:35 · run 40717006293 (pod-clips): 13 clips pagados + máster copiados (cifrado) para desarrollar sin pagar.
  Política `recraft` en producción: **enabled=false** (topes USD 10/día, 50/mes, 250 llamadas); anthropic: 20 llamadas/día.

## Recursos generados (Recraft v3 vía fal; presupuesto restante de Podcast ≈ USD 0,92 antes de esto)
- 15:36 · run 40717043343: 14 imágenes (6 fondos, 6 retratos, 2 referencias de estilo) ≈ USD 0,56.
- 16:00 · run 40718851716: 4 solicitudes (1 sin imagen) ≈ USD 0,16 → retratos frontales de Ximena y Víctor.
- 16:25 · run 40720734715: 2 solicitudes (1 sin imagen) ≈ USD 0,08.
- Acumulado recursos ≈ **USD 0,80** (contando las solicitudes sin imagen). Quedan ≈ USD 0,12 del tope de Podcast.
- 17:3x · run 40726077959 (pod-catalog, USD 0): catálogo en almacenamiento privado (fotos, recortes, muestra de Valeria).

## Verificación previa con material ya pagado (horas UTC del 2026-10-28)
- 16:50 · run 40729682472 (pod-fragment): 1 ilustración Recraft (zigurat con tablillas, rotulada «Recreación») aceptada
  por la verificación visual local; **USD 0,04** (llamada directa del arnés con tope de caso USD 0,2, fuera del libro del
  estudio). Fragmento de 44,28 s. **Defecto visto:** cada persona salía como rectángulo opaco con su fondo original.
  Causa: `eq` del ffmpeg estático 2018 (el del arnés) descarta el alfa; corrección: color antes de `alphamerge` + prueba
  que pinta de verde el exterior del recorte y exige 0 píxeles verdes (falla con el ffmpeg viejo sin la corrección).
  El worker de producción usa ffmpeg 6.1 (apt), que no tenía el problema.
- 17:07 · run 40732619819: mismo fragmento reutilizando la ilustración (USD 0). Recorte correcto; Cálido/Minimalista con
  busto «flotando» sobre la mesa en retratos cerrados → prolongación inferior del recorte igual a la lateral.
- 17:00–17:38 · runs 40731420479 / 40732298023 / 40734704295 / 40736971768 (pod-scan, USD 0): verificación visual sobre
  un fotograma cada 4 s del episodio original. Rechazados todos los recursos ajenos señalados (regalo de bienvenida 34 s,
  huevos de Pascua 86–90 s, avión 154–158 s, bicicleta 162 s, plantas 314–350 s, lencería 370–378 s). Falsos positivos
  hallados en la 3.ª pasada (restaurante moderno, escritorio con papeles) → nuevos rivales genéricos; 4.ª pasada: 71/95
  rechazados y ningún recurso ajeno aceptado (los planos de avatar con subtítulos no cuentan: no se verifican).
- 17:44 · run 40736976343 (pod-fragment, USD 0): con los rivales nuevos la ilustración sigue aceptada; plano general 9:16
  recortado a los dos asientos (personas ~1,4× más grandes). Primer plano 9:16 algo más cercano (19:00 aprox.).
- CI de #244: el test de estimación esperaba verificación con Anthropic (ahora es local, USD 0) y el E2E de cierre no
  contaba ilustración/guion visual/verificación como llamadas del libro (78/81). Corregidos; local: unit 2436/0,
  podcast3 95/0, E2E cierre 81/81 (PostgreSQL 16 desechable).
- Acumulado de esta tarea: recursos ≈ USD 0,80 + ilustración del fragmento USD 0,04 = **≈ USD 0,84**.
