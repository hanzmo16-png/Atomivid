"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/dashboard", label: "Inicio", d: "M10.7 2.3a1 1 0 00-1.4 0l-7 7A1 1 0 003 11h1v6a1 1 0 001 1h3v-5h4v5h3a1 1 0 001-1v-6h1a1 1 0 00.7-1.7l-7-7z" },
  { href: "/dashboard#estudios", label: "Estudios", d: "M3 4a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H4a1 1 0 01-1-1V4zm8 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V4zm-8 8a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H4a1 1 0 01-1-1v-4zm8 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" },
  null, // botón central «Crear»
  { href: "/dashboard#proyectos", label: "Biblioteca", d: "M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V7a2 2 0 00-2-2h-5.6L8.7 3.3A1 1 0 008 3H4z" },
  { href: "/dashboard/billing", label: "Perfil", d: "M10 10a4 4 0 100-8 4 4 0 000 8zm-7 8a7 7 0 1114 0H3z" },
] as const;

/** Pantallas de navegación donde aparece el dock. Dentro de un estudio no: sus barras de acción fijas (p. ej. «Generar
 * episodio» del asistente de Podcast, sticky bottom-0) quedarían tapadas. */
export function dockVisibleOn(pathname: string): boolean {
  return pathname === "/dashboard" || pathname === "/dashboard/billing" || pathname.startsWith("/dashboard/billing/");
}

/**
 * Navegación inferior flotante del teléfono (< 640 px): Inicio, Estudios, Crear (central), Biblioteca y Perfil.
 * Solo rutas que ya existen. Respeta la zona segura inferior (barra de gestos) y deja áreas táctiles de 48 px.
 * Es `sticky` (no `fixed`) y va último en la página: flota pegado abajo mientras se desplaza y, al llegar al final, ocupa
 * su propio sitio, así que nunca deja tapado el último contenido ni el botón de ayuda.
 */
export function MobileDock() {
  const pathname = usePathname();
  if (!dockVisibleOn(pathname)) return null;
  return (
    <nav aria-label="Navegación principal" data-testid="mobile-dock"
      className="sticky bottom-0 z-30 mt-6 px-4 max-[359px]:px-2 sm:hidden" style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}>
      <ul className="glass-strong mx-auto flex max-w-md items-center justify-between rounded-[28px] px-2 py-1.5 max-[359px]:px-1 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.85)]">
        {ITEMS.map((it, i) => it === null ? (
          <li key="crear" className="-mt-7">
            <Link href="/dashboard#crear" aria-label="Crear" data-testid="dock-crear"
              className="flex size-16 items-center justify-center rounded-full bg-champagne text-obsidian shadow-[0_10px_30px_-6px_rgba(230,207,159,0.7)] ring-4 ring-obsidian transition-transform active:scale-95">
              <svg width="26" height="26" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" /></svg>
            </Link>
          </li>
        ) : (
          <li key={it.href + i}>
            {(() => {
              const active = it.href === "/dashboard" ? pathname === "/dashboard" : !it.href.includes("#") && pathname.startsWith(it.href);
              return (
                <Link href={it.href} aria-current={active ? "page" : undefined}
                  className={`flex min-h-12 min-w-14 flex-col items-center justify-center gap-0.5 rounded-2xl px-2 text-[11px] max-[359px]:min-w-12 max-[359px]:px-1 font-medium transition-colors ${active ? "text-champagne" : "text-ink-muted active:text-ink"}`}>
                  <svg width="22" height="22" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" clipRule="evenodd" d={it.d} /></svg>
                  {it.label}
                </Link>
              );
            })()}
          </li>
        ))}
      </ul>
    </nav>
  );
}
