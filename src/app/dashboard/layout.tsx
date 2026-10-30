import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "@/app/auth/actions";
import { Logo } from "@/components/ui/Logo";
import { LinkButton } from "@/components/ui/Button";
import { Onboarding } from "@/components/onboarding/Onboarding";
import { NavLink } from "./NavLink";
import { CLIENT_NAV } from "@/lib/ux/create-home";

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

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-border bg-canvas/90 backdrop-blur">
        {/* Simple UX 1.0: menú del cliente (Mis proyectos, Facturación, Mi cuenta, Ayuda) y una sola acción principal
            («Crear»). Las herramientas internas (pruebas, centro de mando) ya no están aquí: viven en «Mi cuenta» y solo
            para quien tiene acceso. En móvil, un menú compacto (sin barra horizontal cortada). */}
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-4 py-3 sm:px-6">
          <Link href="/dashboard" aria-label="Inicio">
            <Logo />
          </Link>
          <nav aria-label="Principal" className="hidden items-center gap-1 sm:flex">
            {CLIENT_NAV.map((n) => (
              <NavLink key={n.href} href={n.href} exact={n.href === "/dashboard"} className="rounded-md px-3 py-2 text-sm font-medium transition-colors">
                {n.label}
              </NavLink>
            ))}
            <LinkButton href="/dashboard#crear" size="sm" className="ml-1">Crear</LinkButton>
          </nav>
          <div className="flex items-center gap-2 sm:hidden">
            <LinkButton href="/dashboard#crear" size="sm">Crear</LinkButton>
            <details className="relative" data-testid="menu-movil">
              <summary className="flex min-h-11 cursor-pointer list-none items-center rounded-md border border-border px-3 text-sm font-medium text-ink">Menú</summary>
              <nav aria-label="Menú" className="absolute right-0 mt-2 grid w-56 gap-1 rounded-xl border border-border bg-canvas p-2 shadow-lg">
                {CLIENT_NAV.map((n) => (
                  <NavLink key={n.href} href={n.href} exact={n.href === "/dashboard"} className="block min-h-11 rounded-md px-3 py-3 text-base">
                    {n.label}
                  </NavLink>
                ))}
                <form action={signOut}>
                  <button type="submit" className="block min-h-11 w-full rounded-md px-3 py-3 text-left text-base text-ink-muted hover:text-ink">Cerrar sesión</button>
                </form>
              </nav>
            </details>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{children}</main>
      <Onboarding />
    </div>
  );
}
