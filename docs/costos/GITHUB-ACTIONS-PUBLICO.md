# Render en GitHub Actions: gratis solo mientras el repositorio sea público

El render de Reels, Avatar y Long Form corre en `.github/workflows/render.yml`, con runners estándar de GitHub Actions. Hoy no tiene coste por minuto **porque el repositorio es público**: GitHub no factura minutos de runners estándar en repos públicos.

Esta regla no se pudo reverificar el 2026-10-13, porque la documentación de GitHub no era accesible desde el entorno de trabajo. Hay que confirmarla en «About billing for GitHub Actions» antes de cualquier decisión.

## Si el repositorio pasa a privado (estimación, no medida)

- **Minutos incluidos.** GitHub Free incluye 2.000 min/mes para repos privados y Pro 3.000; después se factura por minuto.
- **Tarifa por minuto.** Se usa la de `src/lib/billing/pricing.ts`: `PRICING_RENDER_USD_PER_MINUTE`, por defecto USD 0,006/min en Linux desde 2026-01-01, según el comentario del código. Confirmar con la página oficial.
- **Duración por job.** Se toma del último job real `render-video` correcto (2026-10-09): ≈14 min de reloj, incluida la instalación.
- **Reintentos.** Se suma un 15% (supuesto del simulador).

| Videos Reel/día | Minutos/mes (×30 días, ×1,15) | Excedente sobre 2.000 min | Coste estimado/mes |
|---|---|---|---|
| 5 | 2.415 | 415 | ≈ USD 2,5 |
| 10 | 4.830 | 2.830 | ≈ USD 17 |
| 15 | 7.245 | 5.245 | ≈ USD 31 |
| 40 | 19.320 | 17.320 | ≈ USD 104 |

Long Form tarda bastante más por video: en la evidencia de VIDEO #001, unos 32 min para unos 11 min de video. Hay que calcularlo aparte con su duración real.

**Alternativa sin minutos de GitHub:** Remotion Lambda o Cloud Run, de pago por uso (ver «Worker en background» en el README y el simulador de costos de chatgpt-07). Ninguna está contratada.

**Antes de cambiar la visibilidad del repo:** medir los minutos reales por job en la pestaña Actions y decidir el plan. Cambiar la visibilidad no es parte de este PR.
