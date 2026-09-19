"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Link de navegación del dashboard que resalta la sección activa. Único
 * motivo de ser un Client Component en este layout, por lo demás un
 * Server Component — `usePathname()` no existe en el servidor.
 */
export function NavLink({
  href,
  exact = false,
  className = "",
  children,
}: {
  href: string;
  exact?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`${className} ${active ? "text-ink" : "text-ink-muted hover:text-ink"}`}
    >
      {children}
    </Link>
  );
}
