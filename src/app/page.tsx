import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    redirect("/dashboard");
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4 text-center">
      <h1 className="text-4xl font-bold text-gray-900">Atomivid</h1>
      <p className="mt-3 max-w-md text-gray-600">
        Genera reels faceless con IA: guion, voz, footage y subtítulos, listos
        para descargar.
      </p>
      <div className="mt-8 flex gap-3">
        <Link
          href="/register"
          className="rounded-md bg-gray-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-gray-700"
        >
          Crear cuenta
        </Link>
        <Link
          href="/login"
          className="rounded-md border border-gray-300 bg-white px-5 py-2.5 text-sm font-medium text-gray-900 hover:bg-gray-50"
        >
          Iniciar sesión
        </Link>
      </div>
    </div>
  );
}
