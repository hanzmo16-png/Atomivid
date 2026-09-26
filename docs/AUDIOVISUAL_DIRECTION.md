# Dirección audiovisual — propuesta funcional

Estado: especificación aprobada por Hans el 26 de septiembre de 2026. No implementada,
sin cambios en producción ni llamadas a proveedores. Continúa el cierre de Panamá;
no sustituye ni vuelve a generar sus recursos aprobados.

## Objetivo acordado

Una elección sencilla debe coordinar imágenes, música y ritmo según la historia.
Hans pide incluir horror, miedo y misterio, y evitar una configuración compleja.

## Experiencia propuesta

Cinco tarjetas iniciales: Cine realista, Ilustración 3D, Anime, Cómic y Horror y
misterio. La última es un preset completo de apariencia oscura y suspenso; las
otras describen principalmente la apariencia. Tema y guion determinan la emoción.
No asumir que cómic significa humor o que realista significa música épica.

Mostrar bajo la elección un resumen legible de la dirección propuesta, por
ejemplo: «Misterio · música de tensión · ritmo pausado». Dejar ajustes opcionales
cerrados inicialmente. Conservar la voz elegida por el cliente.

Separar internamente apariencia, intención narrativa y dirección musical, aunque
el cliente vea una sola elección inicial. Una historia de misterio en cómic debe
mantener dibujos y suspenso. El tema no debe alterarse para acomodarlo a un preset.

## Reglas de producción

- Resolver una dirección versionada al aprobar el guion y conservarla durante
  toda la producción y sus reintentos. Una edición posterior del tema, guion o
  estilo debe invalidar/revisar esa dirección antes de generar recursos.
- Prioridad: elección explícita del usuario, intención del guion completo,
  energía de cada escena. Palabras aisladas no pueden sustituir el género.
- Imágenes: mantener paleta, iluminación y tratamiento del preset. Para anime,
  cómic e ilustración 3D, no sustituir silenciosamente una escena por stock realista.
  Validar disponibilidad y presupuesto antes de iniciar generación de pago.
- Música: reutilizar pistas del catálogo cuyo tono sea compatible con la dirección.
  Prohibir el fallback a cualquier pista si no hay coincidencia. Mostrar/registrar
  el problema para revisión; no producir música nueva de pago automáticamente.
- Ritmo: adaptar duración de planos y movimiento al desarrollo narrativo y a los
  timestamps reales de voz. Suspenso debe permitir espera y revelación; no implica
  que todos sus planos sean lentos. Acción puede acelerar; reflexión debe respirar.
- Voz: conservar identidad e idioma. Guiar la redacción y puntuación para la
  intención narrativa. No prometer control de actuación no soportado por el
  proveedor, ni regenerar audio aprobado para imponer un estilo.
- Mezcla: mantener inteligible la narración, controlar picos y evitar sustos de
  volumen. Subtítulos legibles y sincronizados con la voz real.
- Diferenciar imágenes con paneo/zoom de clips con animación generada. No convertir
  una selección de apariencia en autorización para usar Veo u otro proveedor caro.

## Hallazgos comprobados en el código base ea4587c

- `providers/music/manifest.ts` registra 22 pistas: dos de Pixabay y veinte de
  Eleven Music. Incluye Tension Dark y Tension Pulse. Esto acredita el catálogo
  registrado, no una nueva comprobación de disponibilidad o escucha de cada archivo.
- `providers/music/tone.ts` infiere tono desde estilo y palabras de tema/guion;
  las palabras tienen más peso que el estilo y pueden desviar la intención.
- `providers/music/select.ts` cuenta coincidencias sin respetar el orden de los
  tonos y permite cualquier pista como fallback cuando no hay coincidencia.
- `video/generate-video.ts` llama a `splitIntoBeats` con límites comunes,
  sin adaptar esos límites a género o energía de la escena.
- `video/visual-resource-planner.ts` puede caer a stock por flags, confianza o
  presupuesto. El catálogo visual necesita una política de coherencia explícita.
- El formulario separa tema e idioma, pero su actual «Estilo / tono» describe
  contenido, no un perfil completo de apariencia, música y montaje.

## Aceptación antes de publicar

1. Horror/misterio mantiene tensión incluso si el guion menciona éxito, negocios
   o celebración; esas palabras aisladas no seleccionan música motivacional.
2. Cómic con misterio y cómic con humor conservan el mismo lenguaje visual y
   producen direcciones de música y ritmo distintas.
3. Ausencia de música compatible o imágenes compatibles se detecta sin fallback
   contradictorio, sin gasto adicional automático y con estado visible.
4. El montaje cubre exactamente el audio aprobado, conserva legibilidad y no
   introduce clips congelados, huecos ni cortes de palabras.
5. Probar persistencia, validación de servidor, reintentos y solicitudes anteriores.
6. Pruebas sin red primero. Las muestras reales requieren presupuesto autorizado
   si faltan recursos; revisar imagen Y escuchar audio antes de aprobar calidad.

## Secuencia

Work cierra entrega de Panamá y realiza la revisión independiente. Claude puede
implementar en paralelo la dirección compartida en reels, conectar las cinco
tarjetas y validar con fixtures en una rama aislada. Las muestras reales se
presupuestan después de esa validación. Extender a documentales posteriormente
con sus ritmos propios; no imponer el ritmo de reels a Long Form.

## Reparto de trabajo y gasto

- Work: documental Panamá, apertura aprobada, vinculación del resultado y
  miniatura, duración real, reproducción y descargas. Revisión independiente
  de los perfiles cuando Claude entregue su PR.
- Claude: contratos de dirección, persistencia y validación, selector de cinco
  opciones para reels, propagación a imágenes/música/montaje, pruebas y draft PR.
- Para evitar conflictos, Claude no modifica `ResultView`, página del video,
  tarjetas del Historial, manifiestos de Panamá ni scripts de su entrega.
  Work no modifica el pipeline de reels, formulario de nuevos reels, selector
  musical ni módulos de dirección durante esta implementación.
- Preservar solicitudes antiguas; cualquier migración será aditiva y se entrega
  para revisión. No fusionar, desplegar o aplicar migraciones productivas en
  esta misión de Claude. PR #10 y facturación quedan fuera del alcance.
- Hans acepta considerar pruebas pagadas, pero solo autoriza cada gasto DESPUÉS
  de recibir objetivo, proveedores, costo estimado y máximo. No hay un monto
  autorizado para esta nueva misión. Preparar código y fixtures sin esperar;
  solicitar el presupuesto únicamente al llegar a una prueba real necesaria.
- No afirmar revisión por Grok u otro agente si esa revisión no ocurrió.
