import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "@/app/auth/actions";
import { Logo } from "@/components/ui/Logo";
import { LinkButton } from "@/components/ui/Button";
import { Onboarding } from "@/components/onboarding/Onboarding";
import { NavLink } from "./NavLink";
import { isLongFormEnabled, isLongFormAllowlisted } from "@/lib/video/long-form/access";
import { getFeatureFlags } from "@/lib/video/feature-flags";

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

  // Mismo gate Long Form/allowlist que ya usa /dashboard/long-form/visual-test-v2
  // (isLongFormEnabled + isLongFormAllowlisted, access.ts) — este acceso
  // directo es solo navegación, nunca hace ninguna llamada por su cuenta.
  const showLongFormDryRun = isLongFormEnabled() && isLongFormAllowlisted(user);
  const flags = getFeatureFlags();

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-border bg-canvas/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3.5 sm:px-6">
          <Link href="/dashboard">
            <Logo />
          </Link>
          <nav className="flex items-center gap-1 sm:gap-2">
            <NavLink
              href="/dashboard"
              exact
              className="hidden rounded-md px-3 py-2 text-sm font-medium transition-colors sm:inline-block"
            >
              Historial
            </NavLink>
            {flags.textToSpeechEnabled && (
              <NavLink
                href="/dashboard/tts"
                className="hidden rounded-md px-3 py-2 text-sm font-medium transition-colors sm:inline-block"
              >
                Texto a voz
              </NavLink>
            )}
            <NavLink
              href="/dashboard/billing"
              className="hidden rounded-md px-3 py-2 text-sm font-medium transition-colors sm:inline-block"
            >
              Facturación
            </NavLink>
            {showLongFormDryRun && (
              <NavLink
                href="/dashboard/long-form/visual-test-v2"
                className="hidden rounded-md px-3 py-2 text-sm font-medium transition-colors sm:inline-block"
              >
                Dry Run Long Form
              </NavLink>
            )}
            <LinkButton href="/dashboard/new" size="sm">
              Nuevo video
            </LinkButton>
            <form action={signOut}>
              <button
                type="submit"
                className="rounded-md px-2.5 py-2 text-sm font-medium text-ink-muted transition-colors hover:text-ink"
                aria-label="Cerrar sesión"
                title="Cerrar sesión"
              >
                Salir
              </button>
            </form>
          </nav>
        </div>
        <div className="border-t border-border px-4 py-2 sm:hidden">
          <div className="flex gap-4 text-sm font-medium">
            <NavLink href="/dashboard" exact>
              Historial
            </NavLink>
            {flags.textToSpeechEnabled && <NavLink href="/dashboard/tts">Texto a voz</NavLink>}
            <NavLink href="/dashboard/billing">Facturación</NavLink>
            {showLongFormDryRun && (
              <NavLink href="/dashboard/long-form/visual-test-v2">Dry Run Long Form</NavLink>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{children}</main>
      <Onboarding />
    </div>
  );
}
