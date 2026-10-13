# Tarifa de voz (ElevenLabs): valores efectivos por recorrido

Estado: **sin cambios de comportamiento**. Una versión anterior de PR #109 unificaba la tarifa en una constante de 0,20. Se retiró: sin override, el valor por defecto de la app habría pasado de 0,10 a 0,20, y la tarifa real de la cuenta no está acreditada.

## Valores efectivos

| Recorrido | Origen del valor | USD / 1000 caracteres |
|---|---|---|
| Worker de Reels (`render.yml`) | Literal en el workflow | 0,2 |
| Worker de podcast (`podcast-video.yml`) | Literal en el workflow | 0,2 |
| `gucci-production-start.yml` | Literal en el workflow (no se toca: posible material de Travis Walton) | 0,2 |
| App (Vercel) y cualquier proceso sin override | Valor por defecto de `src/lib/billing/pricing.ts` | 0,1, salvo que el entorno defina `PRICING_ELEVENLABS_USD_PER_1K_CHARS` |
| `scripts/voice-comparison.ts` | Valor por defecto propio del script | 0,18 |

## Pendiente (Hans)
- **Tarifa real del plan de ElevenLabs:** desconocida. Se trata como parámetro; no se consultaron secretos ni planes.
- **Producción en Vercel:** no se sabe si define `PRICING_ELEVENLABS_USD_PER_1K_CHARS`. Si no la define, la app estima con 0,1 mientras los workers reservan con 0,2.
- **Unificación:** decidir el valor único y dónde vive (constante o variable) una vez confirmada la tarifa real.
