import Link from "next/link";
import { LinkButton } from "@/components/ui/Button";
import { Logo } from "@/components/ui/Logo";

export default function NotFound() {
  return (
    <div className="bg-atomivid-glow flex min-h-screen flex-col items-center justify-center gap-6 px-4 text-center">
      <Link href="/">
        <Logo />
      </Link>
      <div>
        <p className="text-sm font-semibold uppercase tracking-wide text-ink-faint">Error 404</p>
        <h1 className="mt-2 text-2xl font-bold text-ink">No encontramos esa página</h1>
        <p className="mt-2 max-w-sm text-sm text-ink-muted">
          Puede que el enlace esté roto o que la página se haya movido.
        </p>
      </div>
      <LinkButton href="/">Volver al inicio</LinkButton>
    </div>
  );
}
