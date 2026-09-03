import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "@/app/auth/actions";

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
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4">
          <Link href="/dashboard" className="text-lg font-bold text-gray-900">
            Atomivid
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/dashboard" className="text-gray-600 hover:text-gray-900">
              Historial
            </Link>
            <Link href="/dashboard/billing" className="text-gray-600 hover:text-gray-900">
              Facturación
            </Link>
            <Link
              href="/dashboard/new"
              className="rounded-md bg-gray-900 px-3 py-1.5 font-medium text-white hover:bg-gray-700"
            >
              Nuevo video
            </Link>
            <span className="hidden text-gray-400 sm:inline">{user.email}</span>
            <form action={signOut}>
              <button type="submit" className="text-gray-600 hover:text-gray-900">
                Salir
              </button>
            </form>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
    </div>
  );
}
