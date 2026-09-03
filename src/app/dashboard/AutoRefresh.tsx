"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Refresca la página periódicamente mientras haya solicitudes "processing". */
export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;

    const interval = setInterval(() => {
      router.refresh();
    }, 4000);

    return () => clearInterval(interval);
  }, [active, router]);

  return null;
}
