import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "@/app/auth/actions";
import { Logo } from "@/components/ui/Logo";
import { LinkButton } from "@/components/ui/Button";
import { Onboarding } from "@/components/onboarding/Onboarding";

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
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3.5 sm:px-6">
          <Link href="/dashboard">
            <Logo />
          </Link>
          <nav className="flex items-center gap-1 sm:gap-2">
            <Link
              href="/dashboard"
              className="hidden rounded-md px-3 py-2 text-sm font-medium text-ink-muted transition-colors hover:text-ink sm:inline-block"
            >
              Historial
            </Link>
            <Link
              href="/dashboard/billing"
              className="hidden rounded-md px-3 py-2 text-sm font-medium text-ink-muted transition-colors hover:text-ink sm:inline-block"
            >
              Facturación
            </Link>
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
          <div className="flex gap-4 text-sm">
            <Link href="/dashboard" className="text-ink-muted hover:text-ink">
              Historial
            </Link>
            <Link href="/dashboard/billing" className="text-ink-muted hover:text-ink">
              Facturación
            </Link>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{children}</main>
      <Onboarding />
    </div>
  );
}
