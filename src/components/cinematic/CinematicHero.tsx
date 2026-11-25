import Link from "next/link";

/**
 * Portada cinematográfica. La llamada principal no inventa ninguna ruta: baja a «¿Qué quieres crear hoy?» (#crear),
 * el selector real que abre el flujo de cada formato. El fondo en movimiento lo pinta <CinematicBackground watchId="portada">.
 */
/** `fullscreen`: en escritorio la portada ocupa la primera pantalla y el selector queda debajo, para que se vea la escena. */
export function CinematicHero({ fullscreen = true }: { fullscreen?: boolean }) {
  return (
    <section id="portada" aria-labelledby="portada-titulo" data-testid="cinematic-hero"
      className={`relative flex min-h-[calc(100svh-9rem)] flex-col justify-end pb-10 pt-16 sm:justify-center sm:pb-16 ${fullscreen ? "sm:min-h-[calc(100svh-5rem)]" : "sm:min-h-[62vh]"}`}>
      <p className="cine-rise text-[11px] font-semibold uppercase tracking-[0.32em] text-champagne/90">Estudio cinematográfico ATOMIVID</p>
      <h1 id="portada-titulo" className="cine-rise-2 mt-4 max-w-3xl text-[2.6rem] font-semibold leading-[1.02] tracking-[-0.03em] text-ink sm:text-6xl lg:text-7xl">
        Tu imaginación.<br />
        <span className="text-champagne-gradient">Sin límites.</span>
      </h1>
      <p className="cine-rise-3 mt-5 max-w-xl text-lg text-ink/80 sm:text-xl">Crea historias que merecen ser vistas.</p>
      <div className="cine-rise-3 mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Link href="#crear" data-testid="cinematic-cta"
          className="group inline-flex min-h-14 items-center justify-center gap-3 rounded-full bg-champagne px-7 text-base font-semibold text-obsidian shadow-[0_10px_40px_-10px_rgba(230,207,159,0.65)] transition-all hover:bg-champagne-strong hover:shadow-[0_14px_50px_-10px_rgba(230,207,159,0.8)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-champagne">
          ¿Qué historia vamos a crear hoy?
          <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="transition-transform group-hover:translate-y-0.5"><path fillRule="evenodd" d="M10 3a1 1 0 011 1v9.59l3.3-3.3a1 1 0 111.4 1.42l-5 5a1 1 0 01-1.4 0l-5-5a1 1 0 111.4-1.42l3.3 3.3V4a1 1 0 011-1z" clipRule="evenodd" /></svg>
        </Link>
        <Link href="#estudios" className="inline-flex min-h-12 items-center justify-center rounded-full px-5 text-sm font-medium text-ink/80 underline-offset-4 hover:text-ink hover:underline">
          Explorar estudios
        </Link>
      </div>
    </section>
  );
}
