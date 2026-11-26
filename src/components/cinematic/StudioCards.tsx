import Link from "next/link";
import { STUDIO_SOON, type Studio, type StudioId } from "./studios";

const ICON: Record<StudioId, string> = {
  "long-form": "M2 5a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V5zm6 2.5v5l4.5-2.5L8 7.5z",
  reels: "M6 2a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2V4a2 2 0 00-2-2H6zm2 5.5l4.5 2.5L8 12.5v-5z",
  podcast: "M10 2a3 3 0 00-3 3v5a3 3 0 006 0V5a3 3 0 00-3-3zM5 9a1 1 0 00-2 0 7 7 0 006 6.93V18H7a1 1 0 100 2h6a1 1 0 100-2h-2v-2.07A7 7 0 0017 9a1 1 0 10-2 0 5 5 0 01-10 0z",
  "audio-podcast": "M3 10a7 7 0 1114 0v4a2 2 0 01-2 2h-1a1 1 0 01-1-1v-4a1 1 0 011-1h1a5 5 0 00-10 0h1a1 1 0 011 1v4a1 1 0 01-1 1H5a2 2 0 01-2-2v-4z",
  "command-center": "M3 4a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1H4a1 1 0 01-1-1V4zm8 0a1 1 0 011-1h4a1 1 0 011 1v2a1 1 0 01-1 1h-4a1 1 0 01-1-1V4zm0 6a1 1 0 011-1h4a1 1 0 011 1v6a1 1 0 01-1 1h-4a1 1 0 01-1-1v-6zm-8 3a1 1 0 011-1h4a1 1 0 011 1v3a1 1 0 01-1 1H4a1 1 0 01-1-1v-3z",
};

/** Composición visual de cada estudio con material propio: cine 16:9 (Long Form), pantalla vertical (Reels), foto real
 * del estudio (Podcast, Audio) o panel (Command Center). Imágenes con carga diferida. */
function StudioArt({ studio: s }: { studio: Studio }) {
  const zoom = s.available ? "group-hover:scale-[1.06]" : "grayscale";
  if (s.art === "cinema" && s.image) return (
    <div className="absolute inset-0 bg-black">
      {/* eslint-disable-next-line @next/next/no-img-element -- imagen propia comprimida, carga diferida */}
      <img src={s.image} alt="" loading="lazy" decoding="async" className={`absolute inset-x-0 top-[14%] h-[72%] w-full object-cover transition-transform duration-[1200ms] ease-out ${zoom}`} />
      <span className="absolute bottom-3 right-4 rounded border border-white/25 px-1.5 py-0.5 font-mono text-[10px] tracking-widest text-white/70">16:9</span>
      <span className="absolute inset-x-6 top-[78%] h-px bg-white/15"><span className="block h-px w-2/5 bg-champagne/80" /></span>
    </div>
  );
  if (s.art === "vertical" && s.image) return (
    <div className="absolute inset-0 bg-[radial-gradient(90%_120%_at_70%_10%,#1a2450_0%,#070a17_70%)]">
      <div className={`absolute left-1/2 top-4 h-[150%] w-[34%] -translate-x-1/2 overflow-hidden rounded-[18px] border border-white/20 shadow-[0_20px_50px_-10px_rgba(0,0,0,0.9)] transition-transform duration-[1200ms] ease-out ${s.available ? "group-hover:-translate-y-2" : "grayscale"}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- imagen propia comprimida, carga diferida */}
        <img src={s.image} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
      </div>
      <span className="absolute bottom-3 right-4 rounded border border-white/25 px-1.5 py-0.5 font-mono text-[10px] tracking-widest text-white/70">9:16</span>
    </div>
  );
  if (s.image) return (
    // eslint-disable-next-line @next/next/no-img-element -- imagen propia comprimida, carga diferida
    <img src={s.image} alt="" loading="lazy" decoding="async" className={`size-full object-cover transition-transform duration-[1200ms] ease-out ${zoom}`} />
  );
  return <div className="size-full bg-[radial-gradient(120%_120%_at_20%_20%,#1c2a5c_0%,#0a0f22_60%,#05060c_100%)]" />;
}

/** Tarjetas de los estudios existentes: imagen propia, propósito en una frase y su ruta real (o «Disponible pronto»). */
export function StudioCards({ studios }: { studios: Studio[] }) {
  return (
    <section id="estudios" aria-labelledby="estudios-titulo" className="scroll-mt-24" data-testid="cinematic-studios">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-champagne/80">Estudios</p>
          <h2 id="estudios-titulo" className="mt-2 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Elige tu estudio</h2>
        </div>
      </div>
      <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {studios.map((s) => {
          const body = (
            <>
              <div className="relative h-40 overflow-hidden sm:h-44">
                <StudioArt studio={s} />
                <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(5,6,12,0.05)_0%,rgba(5,6,12,0.55)_60%,rgba(5,6,12,0.95)_100%)]" />
                <span className="absolute left-4 top-4 flex size-10 items-center justify-center rounded-xl border border-white/15 bg-black/35 text-champagne backdrop-blur">
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" clipRule="evenodd" d={ICON[s.id]} /></svg>
                </span>
                {s.internal && <span className="absolute right-4 top-4 rounded-full border border-champagne/40 bg-black/40 px-2.5 py-1 text-[11px] font-medium text-champagne">Solo dueño</span>}
              </div>
              <div className="flex flex-1 flex-col gap-1.5 p-5">
                <h3 className="text-lg font-semibold text-ink">{s.title}</h3>
                <p className="text-sm leading-relaxed text-ink-muted">{s.available ? s.tagline : STUDIO_SOON}</p>
                {s.available && (
                  <span className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-champagne">
                    Abrir estudio
                    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="transition-transform group-hover:translate-x-1"><path fillRule="evenodd" d="M7.3 4.3a1 1 0 011.4 0l5 5a1 1 0 010 1.4l-5 5a1 1 0 01-1.4-1.4L11.6 10 7.3 5.7a1 1 0 010-1.4z" clipRule="evenodd" /></svg>
                  </span>
                )}
              </div>
            </>
          );
          const cls = "glass group flex h-full flex-col overflow-hidden rounded-2xl transition-all duration-300";
          return (
            <li key={s.id} data-testid={`studio-${s.id}`} data-available={s.available ? "1" : "0"}>
              {s.available ? (
                <Link href={s.href} className={`${cls} hover:-translate-y-0.5 hover:border-champagne/35 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-champagne`}>{body}</Link>
              ) : (
                <div aria-disabled="true" className={`${cls} opacity-70`}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
