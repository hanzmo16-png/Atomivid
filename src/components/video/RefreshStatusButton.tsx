"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";

/** Read-only refresh. Never dispatches a generation or creates another request. */
export function RefreshStatusButton({ label = "Actualizar estado" }: { label?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return <button type="button" disabled={pending} onClick={() => startTransition(() => router.refresh())}
    className="rounded-md border border-border-strong px-3 py-2 text-sm font-medium text-ink disabled:opacity-50">
    {pending ? "Actualizando…" : label}
  </button>;
}
