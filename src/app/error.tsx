"use client";

import Link from "next/link";
import { Button, LinkButton } from "@/components/ui/Button";
import { Logo } from "@/components/ui/Logo";

export default function Error({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div className="bg-atomivid-glow flex min-h-screen flex-col items-center justify-center gap-6 px-4 text-center">
      <Link href="/">
        <Logo />
      </Link>
      <div>
        <p className="text-sm font-semibold uppercase tracking-wide text-ink-faint">
          Algo salió mal
        </p>
        <h1 className="mt-2 text-2xl font-bold text-ink">No pudimos cargar esta página</h1>
        <p className="mt-2 max-w-sm text-sm text-ink-muted">
          Fue un error inesperado de nuestro lado. Puedes intentarlo de nuevo.
        </p>
      </div>
      <div className="flex gap-3">
        <Button variant="secondary" onClick={() => retry()}>
          Reintentar
        </Button>
        <LinkButton href="/">Volver al inicio</LinkButton>
      </div>
    </div>
  );
}
