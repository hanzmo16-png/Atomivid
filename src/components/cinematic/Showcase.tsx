"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { formatDuration, type ShowcaseItem } from "./showcase";

/**
 * Tarjeta con vista previa real del archivo. No descarga nada hasta que la tarjeta entra en pantalla; entonces pide solo
 * los metadatos y un fotograma (#t=1.5). Al pasar el puntero o enfocar, reproduce en silencio; al salir, para y suelta.
 * La duración se mide del propio archivo.
 */
function Card({ item }: { item: ShowcaseItem }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const vid = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(false);
  const [dur, setDur] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || !("IntersectionObserver" in window)) { const id = requestAnimationFrame(() => setNear(true)); return () => cancelAnimationFrame(id); }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setNear(true); io.disconnect(); } }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => () => { const v = vid.current; if (v) { v.pause(); v.removeAttribute("src"); v.load(); } }, []);

  const preview = (on: boolean) => {
    const v = vid.current;
    if (!v || failed) return;
    if (on && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) v.play().catch(() => {});
    else { v.pause(); if (v.currentTime > 2) v.currentTime = 1.5; }
  };
  const d = formatDuration(dur);

  return (
    <Link ref={ref} href={item.href} data-testid="showcase-item" data-duration={dur ?? ""}
      onMouseEnter={() => preview(true)} onMouseLeave={() => preview(false)} onFocus={() => preview(true)} onBlur={() => preview(false)}
      className={`group relative block shrink-0 snap-start overflow-hidden rounded-2xl border border-glass-border bg-obsidian focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-champagne ${item.vertical ? "h-72 w-[162px] sm:h-80 sm:w-[180px]" : "h-72 w-[min(82vw,512px)] sm:h-80 sm:w-[568px]"}`}>
      <div className="absolute inset-0 bg-[radial-gradient(120%_100%_at_30%_20%,#18224a_0%,#070a17_70%)]" />
      {near && !failed && (
        <video ref={vid} src={`${item.url}#t=1.5`} muted playsInline loop preload="metadata" disablePictureInPicture tabIndex={-1} aria-hidden="true"
          onLoadedMetadata={(e) => setDur(e.currentTarget.duration)} onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover transition-transform duration-700 group-hover:scale-[1.04]" />
      )}
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(5,6,12,0)_40%,rgba(5,6,12,0.92)_100%)]" />
      <span className="absolute left-1/2 top-1/2 flex size-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/25 bg-black/40 text-white opacity-90 backdrop-blur transition-all group-hover:scale-110 group-hover:border-champagne/60 group-hover:text-champagne">
        <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M6.5 4.6v10.8a.8.8 0 001.2.7l8.6-5.4a.8.8 0 000-1.4L7.7 3.9a.8.8 0 00-1.2.7z" /></svg>
      </span>
      <div className="absolute inset-x-0 bottom-0 p-3.5">
        <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-champagne/90">{item.genre}{d ? ` · ${d}` : ""}</p>
        <p className="mt-1 line-clamp-2 text-sm font-semibold leading-snug text-ink">{item.title}</p>
      </div>
    </Link>
  );
}

/** Galería «Tus producciones»: solo producciones terminadas de esta cuenta. Sin ninguna, lo dice y ofrece crear. */
export function Showcase({ items }: { items: ShowcaseItem[] }) {
  return (
    <section id="producciones" aria-labelledby="producciones-titulo" className="scroll-mt-24" data-testid="cinematic-showcase">
      <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-champagne/80">ATOMIVID Cinematic Showcase</p>
      <h2 id="producciones-titulo" className="mt-2 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Tus producciones</h2>
      {items.length === 0 ? (
        <div className="glass mt-6 rounded-2xl p-6 text-sm text-ink-muted" data-testid="showcase-empty">
          Aquí aparecerán tus producciones terminadas, listas para ver.{" "}
          <Link href="#crear" className="font-medium text-champagne underline-offset-4 hover:underline">Crea la primera</Link>
        </div>
      ) : (
        <div className="-mx-4 mt-6 overflow-x-auto px-4 pb-3 [scrollbar-width:thin] sm:-mx-6 sm:px-6">
          <ul className="flex snap-x snap-mandatory gap-4">
            {items.map((i) => <li key={i.id}><Card item={i} /></li>)}
          </ul>
        </div>
      )}
    </section>
  );
}
