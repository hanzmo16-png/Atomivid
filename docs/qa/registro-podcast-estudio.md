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
