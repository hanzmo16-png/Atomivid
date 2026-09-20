import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Logo } from "@/components/ui/Logo";

export function LegalLayout({
  title,
  updated,
  toc,
  crossLink,
  children,
}: {
  title: string;
  updated: string;
  toc?: { id: string; label: string }[];
  crossLink: { href: string; label: string };
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <header className="bg-atomivid-glow border-b border-border px-5 py-4">
        <div className="mx-auto max-w-2xl">
          <Link href="/">
            <Logo />
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-5 py-12">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold text-ink">{title}</h1>
          <Badge>{updated}</Badge>
        </div>

        {toc && toc.length > 0 && (
          <nav aria-label="Contenido de esta página" className="mt-6 flex flex-wrap gap-2">
            {toc.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                className="rounded-full border border-border px-3 py-1 text-xs text-ink-muted hover:border-accent-border hover:text-accent"
              >
                {item.label}
              </a>
            ))}
          </nav>
        )}

        <div className="prose-legal mt-8 space-y-5 text-sm leading-relaxed text-ink-muted [&_h2]:mt-8 [&_h2]:scroll-mt-20 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-ink [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1.5">
          {children}
        </div>

        <div className="mt-12 flex gap-4 border-t border-border pt-6 text-sm">
          <Link href="/" className="text-ink-muted hover:text-accent">
            Volver al inicio
          </Link>
          <Link href={crossLink.href} className="text-ink-muted hover:text-accent">
            {crossLink.label}
          </Link>
        </div>
      </main>
    </div>
  );
}
