import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "@/app/auth/actions";
import { Logo } from "@/components/ui/Logo";
import { Onboarding } from "@/components/onboarding/Onboarding";
import { NavLink } from "./NavLink";
import { isCommandCenterAdmin } from "@/lib/command-center/access";
import { canAccessLongFormBeta } from "@/lib/video/long-form/private-access";
import { studioFlagFor } from "@/lib/podcast/v3/studio";
import { canAccessAudioStudio } from "@/lib/audio-studio/access";
import { MobileDock } from "@/components/cinematic/MobileDock";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Herramienta interna de Visual Test V2: solo owner/admin. La allowlist de
  // Long Form no la muestra. El enlace es navegación; no llama a ningún API.
  const showLongFormDryRun = isCommandCenterAdmin(user);
  // Command Center: owner/admin only (same gate as its page and API); plain navigation.
  const showCommandCenter = isCommandCenterAdmin(user);
  // Podcast (estudio audiovisual): mismo gate que la página /dashboard/podcast + interruptor del estudio
  // (PODCAST_V3_ENABLED=1, piloto del dueño, o activado por defecto solo en Vercel Preview). Solo navegación.
  const showPodcast = canAccessLongFormBeta(user) && studioFlagFor(user).enabled;
  // Audio Podcast Studio 1.0: módulo aparte (solo audio). Solo navegación.
  const showAudioStudio = canAccessAudioStudio(user);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-glass-border bg-obsidian/70 backdrop-blur-xl backdrop-saturate-150">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3.5 sm:px-6">
          <Link href="/dashboard" aria-label="Atomicvid, inicio" className="inline-flex min-h-11 shrink-0 items-center">
            {/* < 380 px solo el símbolo: con la marca completa la cabecera no cabe en 320 px (Galaxy S9+). */}
            <span className="max-[379px]:hidden"><Logo /></span>
            <span className="hidden max-[379px]:inline"><Logo iconOnly /></span>
          </Link>
          <nav className="flex items-center gap-1 sm:gap-2">
            <NavLink
              href="/dashboard"
              exact
              className="hidden rounded-md px-3 py-2 text-sm font-medium transition-colors sm:inline-block"
            >
              Historial
            </NavLink>
            <NavLink
              href="/dashboard/billing"
              className="hidden rounded-md px-3 py-2 text-sm font-medium transition-colors sm:inline-block"
            >
              Facturación
            </NavLink>
            {showLongFormDryRun && (
              // xl, not sm: at 640px this label wrapped the header and the help click missed (M3-1).
              <NavLink
                href="/dashboard/long-form/visual-test-v2"
                className="hidden whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors xl:inline-block"
              >
                Dry Run Long Form
              </NavLink>
            )}
            {/* Estudios en la barra superior solo desde lg (1024 px): por debajo van en la fila de estudios (más abajo); así
                la cabecera nunca desborda entre 640 y 1023 px (desborde → el navegador alejaba el zoom y la ayuda quedaba
                bajo la barra fija del asistente, M3-1). */}
            {showPodcast && (
              <NavLink
                href="/dashboard/podcast"
                className="hidden rounded-md px-3 py-2 text-sm font-medium transition-colors lg:inline-block"
              >
                Podcast
              </NavLink>
            )}
            {showAudioStudio && (
              <NavLink
                href="/dashboard/audio-studio"
                // lg, no sm: entre 640 y 1023 px un enlace más desborda la cabecera y tapa la ayuda (M3-1).
                className="hidden whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors lg:inline-block"
              >
                Audio Podcast
              </NavLink>
            )}
            {showCommandCenter && (
              <NavLink
                href="/dashboard/command-center"
                className="hidden whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors lg:inline-block"
              >
                Command Center
              </NavLink>
            )}
            {/* Teléfono: el plan y la suscripción existentes, a un toque (la navegación va en el dock inferior). */}
            <NavLink
              href="/dashboard/billing"
              className="inline-flex min-h-11 items-center whitespace-nowrap rounded-full border border-glass-border px-2.5 text-xs font-medium transition-colors sm:hidden"
            >
              Mi plan
            </NavLink>
            <Link
              href="/dashboard/new"
              className="inline-flex min-h-11 items-center whitespace-nowrap rounded-full bg-champagne px-3 text-sm font-medium text-obsidian shadow-[0_6px_20px_-8px_rgba(230,207,159,0.7)] transition-colors hover:bg-champagne-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-champagne"
            >
              Nuevo video
            </Link>
            <form action={signOut}>
              <button
                type="submit"
                className="inline-flex min-h-11 items-center rounded-md px-2.5 text-sm font-medium text-ink-muted transition-colors hover:text-ink"
                aria-label="Cerrar sesión"
                title="Cerrar sesión"
              >
                Salir
              </button>
            </form>
          </nav>
        </div>
        {(showPodcast || showAudioStudio || showCommandCenter) && (
          // Fila de estudios (< 1024 px): saltar de un estudio a otro también en el teléfono y la tableta, donde el dock
          // no aparece. El ensayo de Long Form no va aquí: es una herramienta interna de escritorio (xl).
          <div className="border-t border-glass-border px-4 py-1.5 lg:hidden" data-testid="studio-strip">
            <div className="mx-auto flex max-w-5xl gap-1 overflow-x-auto whitespace-nowrap text-sm font-medium [scrollbar-width:none]">
              {showPodcast && <NavLink href="/dashboard/podcast" className="inline-flex min-h-11 items-center rounded-full px-3 transition-colors">Podcast</NavLink>}
              {showAudioStudio && <NavLink href="/dashboard/audio-studio" className="inline-flex min-h-11 items-center rounded-full px-3 transition-colors">Audio Podcast</NavLink>}
              {showCommandCenter && <NavLink href="/dashboard/command-center" className="inline-flex min-h-11 items-center rounded-full px-3 transition-colors">Command Center</NavLink>}
            </div>
          </div>
        )}
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{children}</main>
      <Onboarding />
      {/* Navegación inferior flotante del teléfono (solo en Inicio y Plan; los estudios tienen sus propias barras fijas).
          Va la última: es sticky y al final de la página ocupa su sitio sin tapar nada. */}
      <MobileDock />
    </div>
  );
}
