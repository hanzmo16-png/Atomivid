# Thermopylae — Three Days at the Hot Gates · Notas de revisión (versión review-v4)

Entrega para revisión humana. No está publicado ni listo para publicar hasta tu visto bueno.

## Base
- Master V3 aprobado:
  - 751,2 s, 1080p30, −14,0 LUFS.
  - sha256 `86c128870dfeb2e56ec54129da9a3b694e6715b5464b4da1ddb14c04fd7dfc46`.
  - Reconstruido desde sus 12 partes en Storage y verificado antes de editar.
  - El original no se ha tocado.
- Esta versión: `Thermopylae-The-Annals-of-History-review-v4.mp4`, 753,7 s.

## Cambios
1. **Marca del canal:**
   - "Earthward Chronicles" aparecía en dos sitios: la marca de suscripción del CTA 1 (0:49,7–0:54,8) y la tarjeta final.
   - Las dos dicen ahora "The Annals of History", con la misma tipografía y estilo.
   - El CTA 1 se reconstruyó desde el mismo stock aprobado (V4-092).
2. **Audio:** la marca anterior no se dice en ningún momento. Se comprobó en los 330 subtítulos, generados de la narración final, y en el guion.
3. **Santorini/Oia sustituido:**
   - Plano de 11:29,6–11:38,7 ("But the retreat was orderly, the fleet survived, and every city in Greece now knew what resistance looked like."): ahora el paso de las Termópilas al amanecer (V4-002) y, en "and every city…", la línea de escudos en el paso (V4-001). Son clips aprobados del gancho, así que el cierre remite al arranque.
   - CTA 2 (12:20,1–12:29,7): ahora las aguas termales actuales de las Termópilas (stock aprobado V4-032), con la marca de suscripción y campana de antes.
4. **Tarjeta final:**
   - Alargada de 1,5 s a 4,0 s (+2,5 s) para que el crédito se vea unos 3 s.
   - Contenido: título, "THE ANNALS OF HISTORY" y fuentes.
   - Crédito: "Powered by" seguido del logotipo oficial de Atomivid (átomo y nombre), abajo en el centro, de 12:30,2 a 12:33,7. Queda libre la zona central para la pantalla final de YouTube.
5. **Música del cierre:**
   - Es la misma pista del final (elevenlabs-inspirational-2), con su propia salida natural.
   - Se igualó el nivel a la mezcla y se unió con un fundido cruzado de 1 s en 12:29–12:30.
   - Sin locución nueva y sin TTS.

## Sin cambios
- Narración, parches de pronunciación, sincronización, gráficos, subtítulos (el SRT es el mismo) y el resto del montaje.
- La imagen fuera de los tres tramos editados es la del master aprobado; lo mide el PSNR del informe de QA.

## Matices históricos
Se revisaron los cuatro: Efialtes de Traquis, atribución a Simónides, lambda y tebanos. Ninguno contradice sustancialmente la narración. Se aclaran en la descripción y el comentario fijado. El detalle con tiempos exactos está en el archivo de texto de YouTube.

## Contenido alterado o sintético
En YouTube Studio marca "Sí": escenas de batalla y personas realistas generadas con IA, y voz sintética.

## Declaración comercial
Atomivid es nuestra propia plataforma, no un patrocinio de terceros, así que no corresponde marcar "promoción pagada". La relación se hace explícita en la descripción.

## Pendientes
- **Enlace:** el enlace a https://atomivid.vercel.app solo se añade a la descripción si el flujo de entrega lo encontró público (ver `site-check` en el informe).
