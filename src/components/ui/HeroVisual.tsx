import Image from "next/image";
import { LogoMark } from "./Logo";

/**
 * Mockup de un reel vertical. La foto es del propio fundador (autorizada
 * explícitamente para uso público en la landing) — sirve como ejemplo
 * honesto de "para qué es Atomivid", no se presenta como un video generado.
 */
export function HeroVisual() {
  return (
    <div className="relative mx-auto w-full max-w-[280px]" aria-hidden="true">
      {/* Halo detrás del teléfono */}
      <div className="absolute inset-0 -z-10 scale-125 rounded-full bg-accent/20 blur-3xl" />

      <div className="relative aspect-[9/16] w-full overflow-hidden rounded-[2rem] border border-border-strong bg-surface shadow-lg">
        <Image
          src="/images/founder-hero.jpg"
          alt=""
          fill
          sizes="280px"
          priority
          className="object-cover"
        />

        {/* Viñeta para legibilidad de los controles */}
        <div className="absolute inset-0 bg-gradient-to-b from-black/35 via-transparent to-black/55" />

        {/* Barra superior tipo cámara/estado */}
        <div className="absolute inset-x-0 top-0 flex items-center justify-between px-4 pt-3">
          <span className="h-1 w-8 rounded-full bg-white/25" />
          <span className="size-1.5 rounded-full bg-white/25" />
        </div>

        {/* Botón de reproducción central */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex size-14 items-center justify-center rounded-full border border-white/25 bg-white/10 backdrop-blur-sm">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className="translate-x-0.5">
              <path d="M4 2.5v13l11-6.5-11-6.5z" fill="white" />
            </svg>
          </div>
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
