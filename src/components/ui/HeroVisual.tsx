import { LogoMark } from "./Logo";

/**
 * Mockup de un reel vertical. El clip es un video real generado por HeyGen
 * (modo avatar) a partir de una foto del propio fundador, quien autorizó
 * explícitamente su uso público en la landing. En bucle, silenciado y sin
 * controles (autoplay de navegador exige mute) — los subtítulos quemados
 * comunican el mensaje sin necesitar audio. HeyGen otorga al usuario los
 * derechos sobre su User Output y permite uso comercial fuera del plan
 * Free (heygen.com/terms).
 */
export function HeroVisual() {
  return (
    <div className="relative mx-auto w-full max-w-[280px]" aria-hidden="true">
      {/* Halo detrás del teléfono */}
      <div className="absolute inset-0 -z-10 scale-125 rounded-full bg-accent/20 blur-3xl" />

      <div className="relative aspect-[9/16] w-full overflow-hidden rounded-[2rem] border border-border-strong bg-surface shadow-lg">
        <video
          className="absolute inset-0 size-full object-cover"
          poster="/images/founder-hero.jpg"
          autoPlay
          muted
          loop
          playsInline
        >
          <source src="/videos/founder-hero.webm" type="video/webm" />
          <source src="/videos/founder-hero.mp4" type="video/mp4" />
        </video>

        {/* Viñeta para legibilidad de los controles */}
        <div className="absolute inset-0 bg-gradient-to-b from-black/35 via-transparent to-black/55" />

        {/* Barra superior tipo cámara/estado */}
        <div className="absolute inset-x-0 top-0 flex items-center justify-between px-4 pt-3">
          <span className="h-1 w-8 rounded-full bg-white/25" />
          <span className="size-1.5 rounded-full bg-white/25" />
        </div>

        {/* Marca de átomo flotando, sutil */}
        <div className="absolute right-4 top-4 opacity-70">
          <LogoMark size={20} />
        </div>

        {/* Subtítulo quemado, como el que produce el pipeline real */}
        <div className="absolute inset-x-4 bottom-16 rounded-md bg-black/55 px-3 py-1.5 text-center text-xs font-medium text-white backdrop-blur-sm">
          &ldquo;...listo para publicar en minutos.&rdquo;
        </div>

        {/* Barra de progreso */}
        <div className="absolute inset-x-4 bottom-8 h-1 overflow-hidden rounded-full bg-white/20">
          <div className="h-full w-2/3 rounded-full bg-accent" />
        </div>
      </div>

      {/* Insignias flotantes */}
      <span className="absolute -left-6 top-10 hidden rotate-[-6deg] items-center gap-1.5 rounded-full border border-border-strong bg-surface-raised px-3 py-1.5 text-xs font-medium text-ink shadow-md sm:flex">
        <span className="size-1.5 rounded-full bg-success" /> 9:16
      </span>
      <span className="absolute -right-8 top-1/2 hidden -translate-y-1/2 rotate-[5deg] items-center gap-1.5 rounded-full border border-border-strong bg-surface-raised px-3 py-1.5 text-xs font-medium text-ink shadow-md sm:flex">
        Guion + voz + clips
      </span>
    </div>
  );
}
