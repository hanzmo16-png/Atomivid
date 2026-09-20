import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "./Card";
import { LogoMark } from "./Logo";

/**
 * Envoltorio compartido de /login y /register — antes cada página
 * duplicaba el mismo fondo, tarjeta y encabezado con el logo.
 */
export function AuthCard({ subtitle, children }: { subtitle: string; children: ReactNode }) {
  return (
    <div className="bg-atomivid-glow flex min-h-screen items-center justify-center px-4 py-12">
      <Card className="w-full max-w-sm overflow-hidden p-0 shadow-lg">
        <div className="flex flex-col items-center gap-3 border-b border-border px-8 py-8 text-center">
          <span className="flex size-11 items-center justify-center rounded-full bg-accent-soft">
            <LogoMark size={22} />
          </span>
          <div>
            <Link href="/" className="inline-block">
              <span className="text-base font-semibold tracking-tight text-ink">Atomivid</span>
            </Link>
            <p className="mt-0.5 text-sm text-ink-muted">{subtitle}</p>
          </div>
        </div>
        <div className="p-8">{children}</div>
      </Card>
    </div>
  );
}
